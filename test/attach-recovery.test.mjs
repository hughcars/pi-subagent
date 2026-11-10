import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { piPackageForTests, resolvePiImportsFrom } from "./pi-package.mjs";
import {
	attachDiagnosisCommand,
	attachWithRecovery,
	classifyAttachFailure,
	FALLBACK_TERM,
	isTerminalName,
	sshAttachTransport,
	writeMetadata,
} from "../shared.ts";

const target = { where: "abc123 on box", host: "box", tmuxSession: "pi-subagent-abc123", term: "xterm-kitty" };
const report = (session, terminfo, tic) => `session=${session}\nterminfo=${terminfo}\ntic=${tic}\n`;

/** A transport that replays scripted results and records the calls made to it. */
function fakeTransport({ attach = [0], diagnosis = { code: 0, stdout: report(0, 0, 0), stderr: "" }, install = true } = {}) {
	const calls = [];
	const exits = [...attach];
	return {
		calls,
		attach: async (term) => {
			calls.push(term ? `attach:${term}` : "attach");
			return exits.shift();
		},
		diagnose: async (term) => {
			calls.push(`diagnose:${term}`);
			return diagnosis;
		},
		installTerminfo: async (term) => {
			calls.push(`install:${term}`);
			return install;
		},
	};
}

async function recover(transport, overrides = {}) {
	const progress = [];
	const result = await attachWithRecovery(transport, { ...target, ...overrides }, (line) => progress.push(line));
	return { result, progress };
}

test("terminal names are limited to what is safe in a remote command", () => {
	for (const term of ["xterm-kitty", "xterm-256color", "tmux-256color", "screen.xterm-256color", "vt100+"]) assert.ok(isTerminalName(term), term);
	for (const term of [undefined, "", "a b", "x;reboot", "-oProxyCommand=x", "$(id)", "x'y", "x/y"]) assert.ok(!isTerminalName(term), String(term));
});

test("the diagnosis command quotes the session and terminal and reports three statuses", () => {
	const command = attachDiagnosisCommand("it's", "xterm-kitty");
	assert.match(command, /tmux has-session -t 'it'\\''s' 2>\/dev\/null; echo "session=\$\?"/);
	assert.match(command, /infocmp 'xterm-kitty' >\/dev\/null 2>&1; echo "terminfo=\$\?"/);
	assert.match(command, /command -v tic >\/dev\/null 2>&1; echo "tic=\$\?"/);
});

test("a diagnosis report is read as the cause of the failed attach", () => {
	assert.deepEqual(classifyAttachFailure(report(1, 1, 0)), { failure: "no-session", canInstall: false });
	assert.deepEqual(classifyAttachFailure(report(0, 1, 0)), { failure: "unknown-terminal", canInstall: true });
	assert.deepEqual(classifyAttachFailure(report(0, 1, 1)), { failure: "unknown-terminal", canInstall: false });
	// A host without infocmp (127) cannot confirm the entry; it is treated as unknown.
	assert.deepEqual(classifyAttachFailure(report(0, 127, 127)), { failure: "unknown-terminal", canInstall: false });
	assert.deepEqual(classifyAttachFailure(report(0, 0, 0)), { failure: "unexplained", canInstall: false });
	assert.deepEqual(classifyAttachFailure("Last login: today\n" + report(0, 1, 0)), { failure: "unknown-terminal", canInstall: true });
	assert.deepEqual(classifyAttachFailure("garbage"), { failure: "unexplained", canInstall: false });
	assert.deepEqual(classifyAttachFailure("session=0\n"), { failure: "unexplained", canInstall: false });
});

test("an attach that works makes no other call and reports nothing", async () => {
	const transport = fakeTransport();
	const { result, progress } = await recover(transport);
	assert.deepEqual(result, { attached: true });
	assert.deepEqual(transport.calls, ["attach"]);
	assert.deepEqual(progress, []);
});

test("an unknown terminal is installed on the host and the attach is repeated unchanged", async () => {
	const transport = fakeTransport({ attach: [1, 0], diagnosis: { code: 0, stdout: report(0, 1, 0), stderr: "" } });
	const { result, progress } = await recover(transport);
	assert.deepEqual(transport.calls, ["attach", "diagnose:xterm-kitty", "install:xterm-kitty", "attach"]);
	assert.equal(result.attached, true);
	assert.match(result.message, /Installed the xterm-kitty terminal description on box \(in ~\/\.terminfo\)/);
	assert.equal(progress.length, 2);
});

test("a host that cannot compile the entry is attached to with the fallback terminal", async () => {
	const transport = fakeTransport({ attach: [1, 0], diagnosis: { code: 0, stdout: report(0, 1, 1), stderr: "" } });
	const { result } = await recover(transport);
	assert.deepEqual(transport.calls, ["attach", "diagnose:xterm-kitty", `attach:${FALLBACK_TERM}`]);
	assert.equal(result.attached, true);
	assert.match(result.message, new RegExp(`^Attached as ${FALLBACK_TERM}: box does not know terminal xterm-kitty`));
});

test("a failed install falls back to the fallback terminal", async () => {
	const transport = fakeTransport({ attach: [1, 0], diagnosis: { code: 0, stdout: report(0, 1, 0), stderr: "" }, install: false });
	const { result } = await recover(transport);
	assert.deepEqual(transport.calls, ["attach", "diagnose:xterm-kitty", "install:xterm-kitty", `attach:${FALLBACK_TERM}`]);
	assert.equal(result.attached, true);
});

test("an attach that still fails after the repair says what was changed", async () => {
	const installed = fakeTransport({ attach: [1, 1], diagnosis: { code: 0, stdout: report(0, 1, 0), stderr: "" } });
	const afterInstall = (await recover(installed)).result;
	assert.equal(afterInstall.attached, false);
	assert.match(afterInstall.message, /ssh exit 1\). Installed the xterm-kitty terminal description on box .* still failed/);

	const fallback = fakeTransport({ attach: [1, 255], diagnosis: { code: 0, stdout: report(0, 1, 1), stderr: "" } });
	const afterFallback = (await recover(fallback)).result;
	assert.equal(afterFallback.attached, false);
	assert.match(afterFallback.message, new RegExp(`ssh exit 255\\), also as ${FALLBACK_TERM}`));
});

test("a missing session, an unreachable host and an unexplained exit are reported and not retried", async () => {
	const gone = fakeTransport({ attach: [1], diagnosis: { code: 0, stdout: report(1, 1, 0), stderr: "" } });
	assert.match((await recover(gone)).result.message, /tmux session pi-subagent-abc123 no longer exists there/);
	assert.deepEqual(gone.calls, ["attach", "diagnose:xterm-kitty"]);

	const down = fakeTransport({ attach: [255], diagnosis: { code: 255, stdout: "", stderr: "warning\nConnection timed out during banner exchange\n" } });
	const unreachable = (await recover(down)).result;
	assert.deepEqual(unreachable, { attached: false, message: "Could not attach to abc123 on box: cannot reach box (Connection timed out during banner exchange)" });
	assert.deepEqual(down.calls, ["attach", "diagnose:xterm-kitty"]);

	const odd = fakeTransport({ attach: [255], diagnosis: { code: 0, stdout: report(0, 0, 0), stderr: "" } });
	assert.match((await recover(odd)).result.message, /ended with ssh exit 255\. The tmux session exists and box knows terminal xterm-kitty/);
	assert.deepEqual(odd.calls, ["attach", "diagnose:xterm-kitty"]);
});

test("without a usable TERM the failure is reported and nothing is run on the host", async () => {
	for (const term of [undefined, "bad term"]) {
		const transport = fakeTransport({ attach: [1] });
		const { result } = await recover(transport, { term });
		assert.equal(result.attached, false);
		assert.match(result.message, /TERM is unset or is not a plain terminal name/);
		assert.deepEqual(transport.calls, ["attach"]);
	}
});

/** Fake `ssh` and `infocmp` on PATH. The fake host learns a terminal when `tic` runs on it. */
function fakeHost(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-attach-recovery-")));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const log = join(root, "ssh.log");
	const known = join(root, "terminfo-installed");
	const entry = join(root, "tic-stdin");
	writeFileSync(
		join(bin, "ssh"),
		`#!/bin/sh
for arg do last="$arg"; done
printf '%s\\n' "$*" >> '${log}'
case "$last" in
*has-session*) if [ -e '${known}' ]; then terminfo=0; else terminfo=1; fi; if [ -e '${root}/session-gone' ]; then session=1; else session=0; fi; printf 'session=%s\\nterminfo=%s\\ntic=0\\n' "$session" "$terminfo"; exit 0 ;;
*'tic -x'*) cat > '${entry}'; [ -e '${root}/tic-fails' ] && exit 1; : > '${known}'; exit 0 ;;
esac
[ -e '${root}/session-gone' ] && exit 1
case "$*" in *TERM=${FALLBACK_TERM}*) exit 0 ;; esac
[ -e '${known}' ] && exit 0
exit 1
`,
	);
	writeFileSync(join(bin, "infocmp"), `#!/bin/sh\n[ "$3" = known-term ] || exit 1\nprintf 'known-term|a test terminal,\\n\\tam,\\n'\n`);
	chmodSync(join(bin, "ssh"), 0o755);
	chmodSync(join(bin, "infocmp"), 0o755);
	const savedPath = process.env.PATH;
	process.env.PATH = `${bin}:${savedPath}`;
	t.after(() => {
		process.env.PATH = savedPath;
		rmSync(root, { recursive: true, force: true });
	});
	return { root, known, entry, commands: () => readFileSync(log, "utf8").trimEnd().split("\n") };
}

test("the ssh transport sends the attach, diagnosis and install commands the host needs", async (t) => {
	const host = fakeHost(t);
	const transport = sshAttachTransport("box", "pi-subagent-abc123");

	assert.equal(await transport.attach(), 1);
	assert.equal(await transport.attach(FALLBACK_TERM), 0);
	const diagnosis = await transport.diagnose("known-term");
	assert.deepEqual({ code: diagnosis.code, cause: classifyAttachFailure(diagnosis.stdout) }, { code: 0, cause: { failure: "unknown-terminal", canInstall: true } });
	assert.equal(await transport.installTerminfo("no-local-entry"), false, "a terminal with no local entry is not installed");
	assert.equal(existsSync(host.known), false);
	assert.equal(await transport.installTerminfo("known-term"), true);
	assert.equal(readFileSync(host.entry, "utf8"), "known-term|a test terminal,\n\tam,\n", "the host receives the local entry on stdin");

	assert.deepEqual(host.commands(), [
		"-t box tmux attach-session -t pi-subagent-abc123",
		`-t box env TERM=${FALLBACK_TERM} tmux attach-session -t pi-subagent-abc123`,
		`-o BatchMode=yes -o ConnectTimeout=30 box ${attachDiagnosisCommand("pi-subagent-abc123", "known-term")}`,
		"-o BatchMode=yes -o ConnectTimeout=30 box mkdir -p ~/.terminfo && tic -x -o ~/.terminfo /dev/stdin",
	]);

	writeFileSync(join(host.root, "tic-fails"), "");
	assert.equal(await transport.installTerminfo("known-term"), false, "a tic failure on the host is reported");
});

test("through real processes, a refused terminal is installed and the second attach succeeds", async (t) => {
	const host = fakeHost(t);
	const progress = [];
	const result = await attachWithRecovery(
		sshAttachTransport("box", "pi-subagent-abc123"),
		{ ...target, term: "known-term" },
		(line) => progress.push(line),
	);
	assert.equal(result.attached, true);
	assert.match(result.message, /Installed the known-term terminal description on box/);
	assert.equal(existsSync(host.known), true);
	assert.equal(host.commands().length, 4, "attach, diagnose, install, attach");
	assert.equal(host.commands().at(-1), "-t box tmux attach-session -t pi-subagent-abc123");
});

// Loading index.ts loads the whole Pi package, so this test is opt-in (test/pi-package.mjs).
const { piRoot, skip } = piPackageForTests();

test("/subagent repairs a refused terminal, restarts the TUI, and reports the outcome in the UI", { skip }, async (t) => {
	resolvePiImportsFrom(piRoot);
	const host = fakeHost(t);
	const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_SUBAGENT_RUN_DIR: process.env.PI_SUBAGENT_RUN_DIR, TERM: process.env.TERM };
	process.env.PI_CODING_AGENT_DIR = host.root;
	delete process.env.PI_SUBAGENT_RUN_DIR;
	process.env.TERM = "known-term";
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const runDir = join(host.root, "subagents", "abc123");
	writeMetadata({ version: 1, handle: "abc123", parentSessionId: "parent", host: "box", tmuxSession: "pi-subagent-abc123", runDir,
		sessionFile: join(runDir, "session.jsonl"), cwd: host.root, provider: "test", model: "test", thinking: "off",
		state: "busy", hasStarted: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" });

	// The picker's key hints read Pi's global theme.
	const { initTheme } = await import(pathToFileURL(join(piRoot, "dist/modes/interactive/theme/theme.js")).href);
	initTheme();
	const { default: subagentExtension } = await import("../index.ts");
	let command;
	subagentExtension({ on() {}, events: { on() {}, emit() {} }, registerCommand: (name, options) => { if (name === "subagent") command = options; } });
	assert.ok(command, "the extension registers /subagent");

	const run = async () => {
		const seen = { tui: [], notices: [] };
		const tui = { stop: () => seen.tui.push("stop"), start: () => seen.tui.push("start"), requestRender() {} };
		const ctx = {
			sessionManager: { getSessionId: () => "parent" },
			ui: {
				notify: (message, level) => seen.notices.push([level, message]),
				// Build the real picker and press Enter on its only entry.
				custom: (factory) => new Promise((done) => {
					const component = factory(tui, { fg: (_color, text) => text, bold: (text) => text }, {}, done);
					component.handleInput("\r");
				}),
			},
		};
		await command.handler("", ctx);
		return seen;
	};

	const repaired = await run();
	assert.deepEqual(repaired.tui, ["stop", "start"], "the TUI is stopped for the attach and restarted after it");
	assert.equal(repaired.notices.length, 1);
	assert.equal(repaired.notices[0][0], "info");
	assert.match(repaired.notices[0][1], /Installed the known-term terminal description on box/);
	assert.equal(existsSync(host.known), true);

	const again = await run();
	assert.deepEqual(again.notices, [], "once the host knows the terminal, the attach says nothing");

	writeFileSync(join(host.root, "session-gone"), "");
	const gone = await run();
	assert.deepEqual(gone.tui, ["stop", "start"]);
	assert.deepEqual(gone.notices, [["error", "Could not attach to abc123 on box: tmux session pi-subagent-abc123 no longer exists there"]]);
});
