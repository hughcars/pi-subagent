import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { piPackageForTests, resolvePiImportsFrom } from "./pi-package.mjs";
import {
	pollRemoteRuns,
	readMetadata,
	REMOTE_CLI,
	REMOTE_OUTAGE_POLLS,
	REMOTE_POLL_MS,
	REMOTE_STALE_MS,
	RemoteContact,
	remoteSilenceNote,
	writeMetadata,
} from "../shared.ts";

const SETTLED_AT = "2026-01-02T00:00:00.000Z";

/**
 * A fake `ssh` on PATH whose behaviour depends on the host name:
 *   down*    refuses the connection (exit 255 with an ssh error on stderr)
 *   hang*    connects and never answers
 *   group*   never answers, and has a helper process in its own process group, as a
 *            ProxyCommand is
 *   orphan*  never answers, and has a helper process in a session of its own that keeps
 *            ssh's output pipes open after ssh ends
 *   banner*  answers with text that is not a run list
 *   slow*    answers after three seconds
 *   other    answers at once
 * An answer is the content of <root>/list-<host>.json.
 */
function fakeSsh(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-remote-poll-")));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const log = join(root, "ssh.log");
	writeFileSync(
		join(bin, "ssh"),
		`#!/bin/sh
prev=""
for arg do host="$prev"; prev="$arg"; done
printf '%s\\n' "$*" >> '${log}'
case "$host" in
down*) echo 'banner line' >&2; echo "ssh: connect to host $host port 22: Connection timed out" >&2; exit 255 ;;
hang*) echo $$ > '${root}/ssh.pid'; exec sleep 60 ;;
group*) sleep 30 & echo $! > '${root}/helper.pid'; echo $$ > '${root}/ssh.pid'; exec sleep 60 ;;
orphan*) perl -MPOSIX -e 'setsid(); open(F, ">", $ARGV[0]); close(F); sleep 30' '${root}/helper.ready' & echo $! > '${root}/helper.pid'
	while [ ! -e '${root}/helper.ready' ]; do sleep 0.05; done
	echo $$ > '${root}/ssh.pid'; exec sleep 60 ;;
banner*) echo 'Last login: today'; exit 0 ;;
slow*) sleep 3 ;;
esac
cat '${root}'/list-"$host".json
`,
	);
	chmodSync(join(bin, "ssh"), 0o755);
	const saved = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_SUBAGENT_RUN_DIR: process.env.PI_SUBAGENT_RUN_DIR };
	process.env.PATH = `${bin}:${saved.PATH}`;
	process.env.PI_CODING_AGENT_DIR = root;
	delete process.env.PI_SUBAGENT_RUN_DIR;
	const running = (pidFile) => {
		try {
			execFileSync("kill", ["-0", readFileSync(join(root, pidFile), "utf8").trim()], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		// A helper that was meant to outlive ssh must not outlive the test.
		if (running("helper.pid")) execFileSync("kill", [readFileSync(join(root, "helper.pid"), "utf8").trim()]);
		rmSync(root, { recursive: true, force: true });
	});
	return {
		root,
		commands: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []),
		/** Wait until the fake ssh of a host that never answers has started. */
		sshStarted: async () => {
			for (let tries = 0; tries < 100 && !existsSync(join(root, "ssh.pid")); tries++) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
			assert.ok(existsSync(join(root, "ssh.pid")), "the fake ssh started");
		},
		/** Whether the fake ssh process of the last host that never answers is still running. */
		sshRunning: () => running("ssh.pid"),
		/** Whether that host's helper process is still running. */
		helperRunning: () => running("helper.pid"),
		/** What the host's `subagent list --json` prints. */
		answer: (host, runs) => writeFileSync(join(root, `list-${host}.json`), JSON.stringify(runs)),
	};
}

function run(root, handle, host, overrides = {}) {
	const runDir = join(root, "subagents", handle);
	return { version: 1, handle, parentSessionId: "parent", host, tmuxSession: `pi-subagent-${handle}`, runDir,
		sessionFile: join(runDir, "session.jsonl"), cwd: root, provider: "test", model: "test", thinking: "off",
		state: "busy", hasStarted: true, createdAt: "2026-01-01", updatedAt: "2026-01-01", ...overrides };
}

test("a poll returns the runs the host lists", async (t) => {
	const host = fakeSsh(t);
	host.answer("box", [run(host.root, "abc123", "box", { state: "idle", settledAt: SETTLED_AT })]);
	const poll = await pollRemoteRuns("box");
	assert.equal(poll.ok, true);
	assert.deepEqual(poll.runs.map((entry) => [entry.handle, entry.state, entry.settledAt]), [["abc123", "idle", SETTLED_AT]]);
	// Thirty seconds to connect: a ProxyCommand transport can need twenty.
	assert.deepEqual(host.commands(), [`-o BatchMode=yes -o ConnectTimeout=30 box ${REMOTE_CLI} list --json`]);
});

test("a poll that fails says why and never claims a state", async (t) => {
	const host = fakeSsh(t);
	assert.deepEqual(await pollRemoteRuns("down"), { ok: false, error: "ssh: connect to host down port 22: Connection timed out" });
	assert.deepEqual(await pollRemoteRuns("banner"), { ok: false, error: "the answer was not a list of runs" });
	host.answer("box", { handle: "abc123" });
	assert.deepEqual(await pollRemoteRuns("box"), { ok: false, error: "the answer was not a list of runs" });
});

test("a host that connects and never answers is abandoned at the time limit, and ssh is ended", async (t) => {
	const host = fakeSsh(t);
	const started = Date.now();
	const poll = await pollRemoteRuns("hang", { timeoutMs: 400 });
	assert.deepEqual(poll, { ok: false, error: "no answer within 0.4 s" });
	assert.ok(Date.now() - started < 3000, `the poll returned after ${Date.now() - started} ms`);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	assert.equal(host.sshRunning(), false);
});

test("the time limit ends the helper processes of ssh with it", async (t) => {
	const host = fakeSsh(t);
	const pending = pollRemoteRuns("group", { timeoutMs: 2000 });
	await host.sshStarted();
	assert.equal(host.helperRunning(), true);
	assert.deepEqual(await pending, { ok: false, error: "no answer within 2 s" });
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	assert.deepEqual([host.sshRunning(), host.helperRunning()], [false, false]);
});

test("the time limit holds when a helper process outlives ssh and keeps its pipes open", async (t) => {
	const host = fakeSsh(t);
	const started = Date.now();
	// The limit leaves the helper time to start and leave the group.
	const pending = pollRemoteRuns("orphan", { timeoutMs: 2500 });
	await host.sshStarted();
	assert.deepEqual(await pending, { ok: false, error: "no answer within 2.5 s" });
	// The helper lives on for thirty seconds. A poll that waited for the pipes to close would too.
	assert.ok(Date.now() - started < 6000, `the poll returned after ${Date.now() - started} ms`);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	assert.deepEqual([host.sshRunning(), host.helperRunning()], [false, true]);
});

test("a host name that cannot be passed to ssh is a failed poll, not an exception", async () => {
	const poll = await pollRemoteRuns("bad\u0000host");
	assert.equal(poll.ok, false);
});

test("a cancelled poll ends at once and ends ssh", async (t) => {
	const host = fakeSsh(t);
	const cancel = new AbortController();
	const pending = pollRemoteRuns("hang", { signal: cancel.signal });
	await host.sshStarted();
	assert.equal(host.sshRunning(), true);
	const cancelledAt = Date.now();
	cancel.abort();
	assert.deepEqual(await pending, { ok: false, error: "cancelled" });
	assert.ok(Date.now() - cancelledAt < 1000, "the poll does not wait for its time limit");
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	assert.equal(host.sshRunning(), false);
	// A poll started after the session ended does not run at all.
	assert.deepEqual(await pollRemoteRuns("box", { signal: cancel.signal }), { ok: false, error: "cancelled" });
	assert.equal(host.commands().length, 1);
});

test("a host is silent only after it has not answered for the stale time", () => {
	const contact = new RemoteContact();
	assert.equal(contact.silentFor("box", 5_000_000), undefined, "a host that was never asked is not silent");
	// Before any answer, the silence counts from the first poll of the host, not from the
	// start of the session: a host first used late in a session is not silent at once.
	contact.started("box", 1_000_000);
	assert.equal(contact.silentFor("box", 1_000_000 + REMOTE_STALE_MS), undefined);
	assert.equal(contact.silentFor("box", 1_000_000 + REMOTE_STALE_MS + 1), REMOTE_STALE_MS + 1);
	// The host answers three seconds after it was asked; the silence then counts from the answer.
	contact.answered("box", 1_003_000);
	assert.equal(contact.silentFor("box", 1_003_000 + REMOTE_STALE_MS), undefined);
	// Polls that fail, one period apart, do not interrupt the silence.
	for (let poll = 1; poll <= 15; poll++) {
		contact.started("box", 1_000_000 + poll * REMOTE_POLL_MS);
		contact.failed("box");
	}
	assert.equal(contact.silentFor("box", 1_003_000 + 5 * 60_000), 5 * 60_000);
	assert.equal(contact.silentFor("other", 1_003_000 + 5 * 60_000), undefined, "hosts are independent");
});

test("a host that is asked again after a break starts afresh", () => {
	const contact = new RemoteContact();
	const outage = () => {
		for (let poll = 0; poll < REMOTE_OUTAGE_POLLS - 1; poll++) assert.equal(contact.failed("box"), false);
	};
	contact.started("box", 1_000_000);
	contact.answered("box", 1_001_000);
	outage();
	// Its runs went away for an hour, or the machine slept. The old answer and the old
	// failures say nothing about now.
	const later = 1_000_000 + 3_600_000;
	contact.started("box", later);
	assert.equal(contact.silentFor("box", later + REMOTE_STALE_MS), undefined);
	assert.equal(contact.failed("box"), false, "one failure after the break is not an outage");
	assert.equal(contact.silentFor("box", later + REMOTE_STALE_MS + 1), REMOTE_STALE_MS + 1);
	// The same when the wall clock stepped back: the host is due, and its silence counts from the new time.
	const earlier = later - 7_200_000;
	assert.equal(contact.due("box", earlier), true);
	contact.started("box", earlier);
	assert.equal(contact.silentFor("box", earlier + REMOTE_STALE_MS + 1), REMOTE_STALE_MS + 1);
});

test("each host is asked once per period, and never twice at a time", () => {
	const contact = new RemoteContact();
	assert.equal(contact.due("box", 1000), true, "a host that was never asked is due");
	contact.started("box", 1000);
	assert.equal(contact.due("box", 1000 + 10 * REMOTE_POLL_MS), false, "not while a poll of it runs, however late");
	assert.equal(contact.due("other", 1000), true, "another host is independent");
	contact.answered("box", 5000);
	assert.equal(contact.due("box", 1000 + REMOTE_POLL_MS - 1), false, "the period counts from the start of the poll");
	assert.equal(contact.due("box", 1000 + REMOTE_POLL_MS), true);
	// A poll that took longer than the period is followed by the next one at once.
	contact.started("box", 30_000);
	contact.failed("box");
	assert.equal(contact.due("box", 30_000 + REMOTE_POLL_MS + 5000), true);
});

test("an outage is reported once, after several failed polls in a row", () => {
	const contact = new RemoteContact();
	const failures = () => Array.from({ length: REMOTE_OUTAGE_POLLS + 2 }, () => contact.failed("box"));
	const expected = Array.from({ length: REMOTE_OUTAGE_POLLS + 2 }, (_, index) => index === REMOTE_OUTAGE_POLLS - 1);
	assert.deepEqual(failures(), expected, "reported at the threshold and not again");
	assert.equal(contact.failed("other"), false, "another host has its own count");
	contact.answered("box", 1);
	assert.deepEqual(failures(), expected, "an answer ends the outage, so the next one is reported");
	// One answer between failures means they are not consecutive.
	const mixed = new RemoteContact();
	for (let index = 0; index < REMOTE_OUTAGE_POLLS - 1; index++) assert.equal(mixed.failed("box"), false);
	mixed.answered("box", 1);
	assert.equal(mixed.failed("box"), false);
});

test("the widget note gives the age of an unconfirmed state", () => {
	assert.equal(remoteSilenceNote(undefined), "");
	assert.equal(remoteSilenceNote(REMOTE_STALE_MS + 1), " (no answer 1m)");
	assert.equal(remoteSilenceNote(3 * 60_000 + 59_000), " (no answer 3m)");
	assert.equal(remoteSilenceNote(60 * 60_000), " (no answer 1h)");
	assert.equal(remoteSilenceNote(5 * 60 * 60_000 + 1), " (no answer 5h)");
});

// The tests below load index.ts, so they are opt-in (test/pi-package.mjs).
const { piRoot, skip } = piPackageForTests();

/** Load the parent side of the extension with a fake Pi, and start its session. */
async function startParent(t) {
	resolvePiImportsFrom(piRoot);
	const { default: subagentExtension } = await import("../index.ts");
	const handlers = {};
	const seen = { sent: [], widgets: [], notices: [] };
	subagentExtension({
		on: (name, handler) => (handlers[name] ??= []).push(handler),
		events: { on() {}, emit() {} },
		registerCommand() {},
		sendMessage: (message, options) => seen.sent.push({ message, options, at: Date.now() }),
	});
	const ctx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined, getBranch: () => [] },
		ui: {
			// Only the dimming of an unconfirmed state is of interest here.
			theme: { fg: (color, text) => (color === "muted" ? `[muted]${text}` : text) },
			setWidget: (...args) => seen.widgets.push(args),
			notify: (message, level) => seen.notices.push([level, message]),
		},
	};
	const emit = async (name, event) => {
		for (const handler of handlers[name] ?? []) await handler(event, ctx);
	};
	const startedAt = Date.now();
	await emit("session_start", {});
	// A reload shutdown stops the timers and leaves the runs alone.
	t.after(() => emit("session_shutdown", { reason: "reload" }));
	const until = async (condition, timeoutMs) => {
		while (!condition() && Date.now() - startedAt < timeoutMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		return condition();
	};
	return { seen, until, startedAt, emit };
}

test("a remote run that goes idle wakes its parent once", { skip }, async (t) => {
	const host = fakeSsh(t);
	const shadow = run(host.root, "abc123", "box");
	writeMetadata(shadow);
	host.answer("box", [{ ...shadow, state: "idle", settledAt: SETTLED_AT }]);

	const { seen, until } = await startParent(t);
	assert.ok(await until(() => seen.sent.length > 0, 5000), "the parent is told that the remote run settled");
	const { message, options } = seen.sent[0];
	assert.equal(message.customType, "subagent-state");
	assert.deepEqual([message.details.handle, message.details.state, message.details.settledAt], ["abc123", "idle", SETTLED_AT]);
	assert.match(message.content, /subagent wait abc123/);
	assert.deepEqual(options, { triggerTurn: true });
	const synced = readMetadata(shadow.runDir);
	assert.deepEqual([synced.state, synced.settledAt, synced.parentNotifiedSettledAt], ["idle", SETTLED_AT, SETTLED_AT]);

	await new Promise((resolveDelay) => setTimeout(resolveDelay, 2200));
	assert.equal(seen.sent.length, 1, "later ticks do not repeat the message");
	assert.equal(seen.widgets.at(-1)[1][0], "subagents: abc123:idle@box");
});

test("hosts are polled at the same time, so one slow host does not delay another", { skip }, async (t) => {
	const host = fakeSsh(t);
	for (const [handle, name] of [["aaa111", "slow-a"], ["bbb222", "slow-b"]]) {
		const shadow = run(host.root, handle, name);
		writeMetadata(shadow);
		host.answer(name, [{ ...shadow, state: "idle", settledAt: SETTLED_AT }]);
	}
	// Each host answers after three seconds. One after the other, the second run would be
	// reported after six seconds or more.
	const { seen, until } = await startParent(t);
	assert.ok(await until(() => seen.sent.length === 2, 5500), `both runs are reported within 5.5 seconds (got ${seen.sent.length})`);
	assert.deepEqual(seen.sent.map(({ message }) => message.details.handle).sort(), ["aaa111", "bbb222"]);
});

test("a host that does not answer leaves the last state in place and wakes nobody", { skip }, async (t) => {
	const host = fakeSsh(t);
	const shadow = run(host.root, "abc123", "down");
	writeMetadata(shadow);

	const { seen, until } = await startParent(t);
	assert.equal(await until(() => seen.sent.length > 0, 2500), false, "no message without an answer from the host");
	assert.equal(readMetadata(shadow.runDir).state, "busy");
	assert.equal(seen.widgets.at(-1)[1][0], "subagents: abc123:busy@down", "one failed poll is not yet a silent host");
	assert.deepEqual(seen.notices, [], "and not yet an outage");
	assert.ok(host.commands().length >= 1);
});

test("a host that stays silent is reported once, and its last state is marked with its age", { skip }, async (t) => {
	const host = fakeSsh(t);
	const shadow = run(host.root, "abc123", "down");
	writeMetadata(shadow);

	// The session's one-second tick and its clock are driven by hand; ssh runs in real time.
	// The clock starts half a second before a wall-clock multiple of the period: a poll tied
	// to the wall clock would run again at once, a poll on the session's own clock would not.
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Math.floor(Date.now() / REMOTE_POLL_MS) * REMOTE_POLL_MS - 500 });
	const { seen } = await startParent(t);
	const real = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
	/** Let real time pass until the fake ssh processes have done what the mocked clock asked of them. */
	const settled = async (condition, what) => {
		for (let tries = 0; tries < 200 && !condition(); tries++) await real(50);
		assert.ok(condition(), what);
	};
	const widget = () => seen.widgets.at(-1)[1][0];
	const seconds = async (count) => {
		for (let second = 0; second < count; second++) {
			t.mock.timers.tick(1000);
			await real(20);
		}
	};

	await settled(() => host.commands().length === 1, "the first poll runs when the session starts");
	await seconds(REMOTE_POLL_MS / 1000 - 1);
	await real(300);
	assert.equal(host.commands().length, 1, "the second poll waits a full period from the first");
	await seconds(1);
	await settled(() => host.commands().length === 2, "the second poll runs one period after the first");
	await seconds(REMOTE_POLL_MS / 1000);
	await settled(() => host.commands().length === 3, "the third poll");
	await settled(() => seen.notices.length === 1, "the third failure in a row is reported");
	assert.deepEqual(seen.notices, [[
		"warning",
		"Cannot confirm the subagents on down: ssh: connect to host down port 22: Connection timed out. Their shown states are unconfirmed until the host answers.",
	]]);
	await seconds(REMOTE_STALE_MS / 1000 - 2 * (REMOTE_POLL_MS / 1000));
	assert.equal(widget(), "subagents: abc123:busy@down", "not marked at the stale time");
	await seconds(2);
	assert.equal(widget(), "subagents: [muted]abc123:busy@down (no answer 1m)", "marked and dimmed after it");

	// The host answers again: the mark goes, the parent is told about the settled run, and
	// the warning is not repeated.
	host.answer("down", [{ ...shadow, state: "idle", settledAt: SETTLED_AT }]);
	writeFileSync(join(host.root, "bin", "ssh"), `#!/bin/sh\ncat '${host.root}'/list-down.json\n`);
	for (let second = 0; second < 60 && seen.sent.length === 0; second++) {
		await seconds(1);
		await real(100);
	}
	assert.deepEqual(seen.sent.map(({ message }) => [message.details.handle, message.details.state]), [["abc123", "idle"]]);
	await seconds(1);
	assert.equal(widget(), "subagents: abc123:idle@down");
	assert.equal(seen.notices.length, 1);
});

test("an answer that arrives after the session ended is dropped, and the poll is cancelled", { skip }, async (t) => {
	const host = fakeSsh(t);
	const slow = run(host.root, "abc123", "slow");
	writeMetadata(slow);
	host.answer("slow", [{ ...slow, state: "idle", settledAt: SETTLED_AT }]);
	const hung = run(host.root, "def456", "hang");
	writeMetadata(hung);

	const { seen, emit } = await startParent(t);
	await host.sshStarted();
	assert.equal(host.sshRunning(), true, "the poll of the hung host is running");
	await emit("session_shutdown", { reason: "reload" });
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
	assert.equal(host.sshRunning(), false, "ending the session ends its polls");
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 3500));
	assert.equal(readMetadata(slow.runDir).state, "busy", "the late answer is not recorded");
	assert.deepEqual(seen.sent, []);
	assert.deepEqual(seen.notices, []);
});

