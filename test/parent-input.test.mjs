import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { acknowledgeInput, answerReceiptPath, inputAcknowledged, QuestionBridge, readPendingInput, WAIT_NEEDS_INPUT_EXIT, writePendingInput } from "../input.ts";
import { activeInput, displayRunState, readMetadata, runRemoteBounded, syncRemoteRun, updateMetadata, writeMetadata } from "../shared.ts";
import { piPackageForTests, resolvePiImportsFrom } from "./pi-package.mjs";

// These tests load index.ts with Pi's real event bus and the separate question extension, so
// they are opt-in twice: PI_TEST_PI_ROOT (test/pi-package.mjs) and PI_QUESTION_EXTENSION.
const questionPath = process.env.PI_QUESTION_EXTENSION;
const { piRoot, skip: piSkip } = piPackageForTests();
const skip = piSkip || (!questionPath && "Set PI_QUESTION_EXTENSION to the question.ts working copy");
const integration = (name, fn) => test(name, { skip }, fn);
let subagent, question, createEventBus;
if (!skip) {
	resolvePiImportsFrom(piRoot);
	({ default: subagent } = await import("../index.ts"));
	({ default: question } = await import(pathToFileURL(resolve(questionPath)).href));
	({ createEventBus } = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href));
}
const cliPath = resolve(import.meta.dirname, "../subagent.ts");
const runFile = promisify(execFile);
const params = { question: "Which approach?", options: [
	{ label: "Small patch", description: "Keep the existing bridge" }, { label: "Other" }, { label: "Wait", description: "Do not change yet" },
] };

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-parent-input-test-"));
	const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_SUBAGENT_RUN_DIR: process.env.PI_SUBAGENT_RUN_DIR, PATH: process.env.PATH };
	process.env.PI_CODING_AGENT_DIR = root;
	delete process.env.PI_SUBAGENT_RUN_DIR;
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	process.env.PATH = `${bin}:${process.env.PATH}`;
	const runDir = join(root, "subagents", "abc123");
	const metadata = { version: 1, handle: "abc123", parentSessionId: "parent", tmuxSession: "fake",
		runDir, sessionFile: join(runDir, "session.jsonl"), cwd: root, provider: "test", model: "test", thinking: "off",
		state: "busy", hasStarted: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
	writeMetadata(metadata);
	writeFileSync(metadata.sessionFile, "");
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(root, { recursive: true, force: true });
	});
	const cli = async (...args) => {
		try {
			const result = await runFile(process.execPath, [cliPath, ...args], {
				env: { ...process.env, PI_SUBAGENT_RUN_DIR: "", PI_SESSION_ID: "parent" }, timeout: 12000,
			});
			return { ...result, code: 0 };
		} catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
	};
	return { root, runDir, metadata, cli };
}

async function harness(t, f, { child = false, mode = "tui", idle = !child, sessionId = child ? "child" : "parent", branch = [] } = {}) {
	const hooks = new Map(), tools = new Map(), timers = new Set(), messages = [], prompts = [], widgets = [];
	const bus = createEventBus();
	const pi = { events: bus,
		on: (name, fn) => { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
		registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, setSessionName() {},
		sendMessage: (message, options) => { messages.push({ message, options }); },
		sendUserMessage: (message, options) => prompts.push({ message, options }),
	};
	const ctx = { mode, hasUI: mode === "tui", isIdle: () => idle,
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => f.metadata.sessionFile, getBranch: () => branch },
		ui: { theme: { fg: (_color, text) => text }, setWidget: (...args) => widgets.push(args), notify() {},
			custom() { throw new Error("Managed question must not open local UI"); } },
	};
	const emit = async (name, event = {}) => { for (const hook of hooks.get(name) ?? []) await hook(event, ctx); };
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	globalThis.setInterval = (fn) => { const timer = { fn, unref() {} }; timers.add(timer); return timer; };
	globalThis.clearInterval = (timer) => { timers.delete(timer); };
	if (child) process.env.PI_SUBAGENT_RUN_DIR = f.runDir; else delete process.env.PI_SUBAGENT_RUN_DIR;
	subagent(pi);
	delete process.env.PI_SUBAGENT_RUN_DIR;
	if (child) question(pi);
	try { await emit("session_start"); }
	finally { globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval; }
	let shutdown = false;
	const stop = async () => {
		if (shutdown) return;
		shutdown = true;
		const old = globalThis.clearInterval;
		globalThis.clearInterval = (timer) => timers.delete(timer);
		try { await emit("session_shutdown", { reason: "reload" }); } finally { globalThis.clearInterval = old; }
	};
	t.after(stop);
	const ask = (signal) => tools.get("question").execute("original-call", params, signal, undefined, ctx);
	return { pi, ctx, emit, ask, stop, messages, prompts, widgets, tools,
		setIdle: (value) => { idle = value; }, tick: async () => { for (const timer of timers) await timer.fn(); } };
}

async function answerThroughInbox(f, child, request, answer, overrides = {}) {
	const replyId = randomUUID();
	mkdirSync(join(f.runDir, "inbox"), { recursive: true });
	writeFileSync(join(f.runDir, "inbox", `${replyId}.json`), JSON.stringify({ delivery: "answer", handle: "abc123",
		requestId: request.requestId, replyId, parentSessionId: "parent", answer, ...overrides }));
	await child.tick();
	return JSON.parse(readFileSync(answerReceiptPath(f.runDir, replyId), "utf8"));
}

async function eventually(predicate) {
	for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); }
	assert.fail("Expected condition did not become true");
}

integration("recovery cancels a lost question and publishes fresh readiness without replaying the last turn", async t => {
	const f = fixture(t);
	updateMetadata(f.runDir, { settledAt: "old", parentNotifiedSettledAt: "old", paneId: "%3" });
	writePendingInput(f.runDir, { version: 1, handle: "abc123", requestId: randomUUID(), question: "Lost question?",
		options: [{ label: "Yes" }], createdAt: new Date().toISOString() });
	const oldPane = process.env.TMUX_PANE;
	try {
		process.env.TMUX_PANE = "%9";
		process.env.PI_SUBAGENT_RESUMING = "this-launch";
		const child = await harness(t, f, { child: true, idle: true });
		const fresh = readMetadata(f.runDir);
		assert.deepEqual([fresh.state, fresh.hasStarted, fresh.settledAt, fresh.parentNotifiedSettledAt, fresh.paneId, fresh.resumedLaunch],
			["idle", false, undefined, undefined, "%9", "this-launch"]);
		assert.equal(fresh.pendingInput, undefined);
		assert.deepEqual(child.prompts, []);
		await child.emit("agent_start"); await child.emit("agent_settled");
		assert.ok(readMetadata(f.runDir).settledAt);
		await child.stop(); await harness(t, f, { child: true, idle: true });
		assert.equal(readMetadata(f.runDir).hasStarted, true, "reload is not another recovery");
	} finally {
		delete process.env.PI_SUBAGENT_RESUMING;
		if (oldPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = oldPane;
	}
});

integration("busy child wakes only its dispatching parent; CLI answer resolves the ORIGINAL question without a prompt", async (t) => {
	const f = fixture(t), child = await harness(t, f, { child: true }), parent = await harness(t, f);
	const other = await harness(t, f, { sessionId: "unrelated" });
	let resolved = false;
	const resultPromise = child.ask().then((result) => { resolved = true; return result; });
	const request = readPendingInput(f.runDir);
	assert.ok(request);
	assert.deepEqual(request.options, [params.options[0], params.options[2]]);
	assert.equal(readMetadata(f.runDir).state, "busy");
	assert.equal(readMetadata(f.runDir).settledAt, undefined);
	await parent.tick(); await other.tick();
	assert.equal(parent.messages.length, 1);
	assert.equal(other.messages.length, 0);
	assert.equal(parent.messages[0].options.triggerTurn, true);
	assert.equal(parent.messages[0].message.customType, "subagent-state");
	assert.match(parent.messages[0].message.content, /Keep the existing bridge/);
	assert.match(parent.messages[0].message.content, /task NOT complete/);
	assert.equal(parent.messages[0].message.details.state, "busy");
	assert.ok(parent.widgets.some((w) => JSON.stringify(w).includes("waiting-input")));
	assert.equal(resolved, false);
	// Zero is kept for a settled turn, so a caller that branches on wait does not go on past a question.
	const waiting = await f.cli("wait", "abc123", "--timeout", "1");
	assert.equal(waiting.code, WAIT_NEEDS_INPUT_EXIT, waiting.stderr);
	assert.equal(WAIT_NEEDS_INPUT_EXIT, 2);
	assert.match(waiting.stdout, /needs supervisor input/);
	assert.doesNotMatch(waiting.stdout, /abc123 finished/);
	assert.equal(readMetadata(f.runDir).parentNotifiedSettledAt, undefined);
	const answering = f.cli("answer", "abc123", request.requestId, "--option", "2");
	await eventually(() => existsSync(join(f.runDir, "inbox")) && readdirSync(join(f.runDir, "inbox")).some((p) => p.endsWith(".json")));
	await child.tick();
	const answer = await answering;
	assert.equal(answer.code, 0, answer.stderr);
	const result = await resultPromise;
	assert.match(result.content[0].text, /Supervisor selected: 2. Wait/);
	assert.match(result.content[0].text, /not end-user authorization/);
	assert.equal(result.details.wasCustom, false);
	assert.equal(result.details.source, "supervisor");
	assert.equal(child.prompts.length, 0);
	assert.equal(readPendingInput(f.runDir), undefined);
	assert.equal(readMetadata(f.runDir).state, "busy");
	assert.equal((await f.cli("answer", "abc123", request.requestId, "--cancel")).code, 1);
	await parent.tick(); assert.equal(parent.messages.length, 1);
	// Real settlement path still delivers once, separately from attention.
	child.setIdle(true); await child.emit("agent_settled");
	await parent.tick(); await parent.tick();
	assert.equal(parent.messages.length, 2);
	assert.match(parent.messages[1].message.content, /finished a turn/);
});

integration("free text and explicit cancellation preserve question result semantics", async (t) => {
	const f = fixture(t), child = await harness(t, f, { child: true });
	for (const answer of [{ kind: "text", text: "  use the hook  " }, { kind: "cancel" }]) {
		const resultPromise = child.ask();
		assert.equal((await answerThroughInbox(f, child, readPendingInput(f.runDir), answer)).accepted, true);
		const result = await resultPromise;
		assert.equal(result.details.answer, answer.kind === "text" ? "use the hook" : null);
		assert.equal(result.details.wasCustom, answer.kind === "text" ? true : undefined);
		assert.match(result.content[0].text, /Supervisor/);
	}
});

integration("busy parent defers durable attention; parent reload preserves it and does not duplicate delivery", async (t) => {
	const f = fixture(t), child = await harness(t, f, { child: true });
	const result = child.ask();
	let parent = await harness(t, f, { idle: false });
	await parent.tick();
	const request = readPendingInput(f.runDir);
	assert.equal(parent.messages.length, 0);
	assert.equal(inputAcknowledged(f.runDir, request.requestId), false);
	await parent.stop();
	assert.equal(readPendingInput(f.runDir).requestId, request.requestId);
	parent = await harness(t, f);
	await parent.tick(); await parent.tick();
	assert.equal(parent.messages.length, 1);
	await parent.stop();
	parent = await harness(t, f); await parent.tick();
	assert.equal(parent.messages.length, 0);
	await answerThroughInbox(f, child, request, { kind: "cancel" }); await result;
});

integration("busy-to-idle delivery retries failed sends, while explicit parent wait acknowledges attention only", async (t) => {
	const f = fixture(t), child = await harness(t, f, { child: true });
	const first = child.ask();
	const parent = await harness(t, f, { idle: false });
	await parent.tick(); assert.equal(parent.messages.length, 0);
	parent.setIdle(true);
	const send = parent.pi.sendMessage;
	parent.pi.sendMessage = () => { throw new Error("delivery failed"); };
	await parent.tick();
	assert.equal(inputAcknowledged(f.runDir, readPendingInput(f.runDir).requestId), false);
	parent.pi.sendMessage = send;
	await parent.tick(); await parent.tick();
	assert.equal(parent.messages.length, 1);
	await answerThroughInbox(f, child, readPendingInput(f.runDir), { kind: "cancel" }); await first;
	const second = child.ask(), request = readPendingInput(f.runDir);
	// Status/list show the pending request without consuming the notification.
	const status = await f.cli("status", "abc123", "--json");
	assert.equal(JSON.parse(status.stdout).pendingInput.requestId, request.requestId);
	assert.equal(JSON.parse(status.stdout).state, "busy");
	assert.match((await f.cli("list")).stdout, /waiting-input/);
	assert.equal(inputAcknowledged(f.runDir, request.requestId), false);
	const outsider = await runFile(process.execPath, [cliPath, "wait", "abc123", "--timeout", "1"], {
		env: { ...process.env, PI_SESSION_ID: "outsider" },
	}).catch((error) => error);
	assert.equal(outsider.code, WAIT_NEEDS_INPUT_EXIT);
	assert.match(outsider.stdout, /needs supervisor input/);
	assert.equal(inputAcknowledged(f.runDir, request.requestId), false);
	assert.equal((await f.cli("wait", "abc123", "--timeout", "1")).code, WAIT_NEEDS_INPUT_EXIT);
	assert.equal(inputAcknowledged(f.runDir, request.requestId), true);
	await parent.tick(); assert.equal(parent.messages.length, 1);
	assert.equal(readMetadata(f.runDir).parentNotifiedSettledAt, undefined);
	await answerThroughInbox(f, child, request, { kind: "cancel" }); await second;
});

integration("abort/error parents display without restart, including reload; print/JSON leave attention pending", async (t) => {
	const f = fixture(t), child = await harness(t, f, { child: true });
	const result = child.ask();
	for (const mode of ["print", "json"]) {
		const parent = await harness(t, f, { mode }); await parent.tick();
		assert.equal(parent.messages.length, 0); await parent.stop();
	}
	let parent = await harness(t, f, { idle: false });
	await parent.emit("agent_settled", { aborted: true });
	parent.setIdle(true); await parent.tick();
	assert.equal(parent.messages[0].options.triggerTurn, false);
	await answerThroughInbox(f, child, readPendingInput(f.runDir), { kind: "cancel" }); await result;
	await parent.stop();
	for (const stopReason of ["aborted", "error"]) {
		const next = child.ask();
		parent = await harness(t, f, { branch: [{ type: "message", message: { role: "assistant", stopReason } }] });
		await parent.tick(); assert.equal(parent.messages[0].options.triggerTurn, false);
		await answerThroughInbox(f, child, readPendingInput(f.runDir), { kind: "cancel" }); await next; await parent.stop();
	}
});

integration("invalid, stale, duplicate, wrong-run and wrong-parent inbox replies cannot resolve another question", async (t) => {
	const f = fixture(t), child = await harness(t, f, { child: true });
	const first = child.ask(), request = readPendingInput(f.runDir);
	for (const answer of [{ kind: "option", option: 0 }, { kind: "option", option: 3 }, { kind: "text", text: "  " }, { kind: "cancel", text: "smuggled" }, null]) {
		assert.equal((await answerThroughInbox(f, child, request, answer)).accepted, false);
		assert.equal(readPendingInput(f.runDir).requestId, request.requestId);
	}
	for (const overrides of [{ handle: "wrong" }, { requestId: randomUUID() }, { parentSessionId: "other" }, { requestId: "../../bad" }]) {
		assert.equal((await answerThroughInbox(f, child, request, { kind: "cancel" }, overrides)).accepted, false);
	}
	assert.equal((await f.cli("answer", "abc123", request.requestId, "--option", "7")).code, 1);
	assert.equal((await f.cli("answer", "abc123", request.requestId, "--cancel", "--text", "x")).code, 1);
	await answerThroughInbox(f, child, request, { kind: "cancel" }); await first;
	assert.equal((await answerThroughInbox(f, child, request, { kind: "cancel" })).accepted, false);
	const second = child.ask(), newer = readPendingInput(f.runDir);
	assert.notEqual(newer.requestId, request.requestId);
	assert.equal((await answerThroughInbox(f, child, request, { kind: "option", option: 1 })).accepted, false);
	assert.equal(readPendingInput(f.runDir).requestId, newer.requestId);
	await answerThroughInbox(f, child, newer, { kind: "cancel" }); await second;
});

integration("tool abort and child reload invalidate attention and remove the old resolver/listener", async (t) => {
	const f = fixture(t); let child = await harness(t, f, { child: true });
	const controller = new AbortController(), aborted = child.ask(controller.signal);
	const old = readPendingInput(f.runDir);
	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	controller.abort(); await assert.rejects(aborted, /aborted/);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.equal(readPendingInput(f.runDir), undefined);
	const reloadSignal = new AbortController();
	const reload = child.ask(reloadSignal.signal); const failed = assert.rejects(reload, /shutdown or reload/);
	await child.stop(); await failed;
	assert.equal(getEventListeners(reloadSignal.signal, "abort").length, 0);
	let claimedAfterShutdown = false;
	child.pi.events.emit("question:request:v1", { claim() { claimedAfterShutdown = true; } });
	assert.equal(claimedAfterShutdown, false);
	assert.equal(readPendingInput(f.runDir), undefined);
	// An abrupt process loss can leave a file; the replacement cannot preserve its promise.
	writePendingInput(f.runDir, old);
	child = await harness(t, f, { child: true });
	assert.equal(readPendingInput(f.runDir), undefined);
	const next = child.ask(); const current = readPendingInput(f.runDir);
	assert.equal((await answerThroughInbox(f, child, old, { kind: "cancel" })).accepted, false);
	await answerThroughInbox(f, child, current, { kind: "cancel" }); await next;
	const preAborted = new AbortController(); preAborted.abort();
	await assert.rejects(child.ask(preAborted.signal), /aborted/);
	assert.equal(readPendingInput(f.runDir), undefined);
});

integration("supervisor close cancels the blocked tool before queuing cleanup; further questions cannot deadlock close", async (t) => {
	const f = fixture(t), child = await harness(t, f, { child: true });
	const result = child.ask(); const failed = assert.rejects(result, /supervisor close/);
	mkdirSync(join(f.runDir, "inbox"));
	writeFileSync(join(f.runDir, "inbox", "close.json"), JSON.stringify({ delivery: "close", message: "cleanup" }));
	await child.tick(); await failed;
	assert.equal(readPendingInput(f.runDir), undefined);
	assert.deepEqual(child.prompts, [{ message: "cleanup", options: { deliverAs: "followUp" } }]);
	assert.equal(readMetadata(f.runDir).closing, true);
	await assert.rejects(child.ask(), /closing this run/);
	let exit;
	t.mock.method(process, "exit", (code) => { exit = code; });
	child.setIdle(true); await child.emit("agent_settled");
	assert.equal(exit, 0);
	assert.equal(readMetadata(f.runDir).state, "exited");
});

integration("child quit rejects pending input; an ownerless managed child fails instead of falling back to UI", async (t) => {
	const f = fixture(t), child = await harness(t, f, { child: true });
	updateMetadata(f.runDir, { parentSessionId: undefined });
	await assert.rejects(child.ask(), /no dispatching parent/);
	assert.equal(readPendingInput(f.runDir), undefined);
	updateMetadata(f.runDir, { parentSessionId: "parent" });
	const result = child.ask(), failed = assert.rejects(result, /shutdown or reload/);
	await child.emit("session_shutdown", { reason: "quit" }); await failed;
	assert.equal(readPendingInput(f.runDir), undefined);
	assert.equal(readMetadata(f.runDir).state, "exited");
});

integration("standalone question retains real custom UI, catch-all filtering, option/free-text/cancel behavior", async (t) => {
	const tools = new Map(), pi = { events: createEventBus(), registerTool: (tool) => tools.set(tool.name, tool) };
	question(pi);
	const tool = tools.get("question");
	const theme = { fg: (_color, s) => s, bold: (s) => s };
	for (const action of ["option", "text", "cancel"]) {
		const ctx = { mode: "tui", ui: { custom: (factory) => new Promise((done) => {
			const component = factory({ requestRender() {}, terminal: { columns: 80, rows: 24 } }, theme, {}, done);
			const rendered = component.render(80).join("\n");
			assert.doesNotMatch(rendered, /Other/);
			assert.match(rendered, /Keep the existing bridge/);
			assert.match(rendered, /3. Type something/);
			if (action === "cancel") component.handleInput("\x1b");
			else if (action === "option") component.handleInput("\r");
			else {
				component.handleInput("\x1b[B"); component.handleInput("\x1b[B"); component.handleInput("\r");
				component.handleInput("  custom text  "); component.handleInput("\r");
			}
		}) } };
		const result = await tool.execute("local", params, undefined, undefined, ctx);
		assert.equal(result.details.source, undefined);
		assert.equal(result.details.answer, action === "option" ? "Small patch" : action === "text" ? "custom text" : null);
		assert.match(result.content[0].text, /^User /);
	}
	const nonUI = await tool.execute("local", params, undefined, undefined, { mode: "print" });
	assert.match(nonUI.content[0].text, /UI not available/);
});

integration("claim is synchronous and exclusive; errors after claim reject instead of opening a second UI", async () => {
	const tools = new Map(), bus = createEventBus(); question({ events: bus, registerTool: (tool) => tools.set(tool.name, tool) });
	let secondClaim;
	bus.on("question:request:v1", (event) => {
		const responder = event.claim();
		Promise.resolve().then(() => responder.reject(new Error("transport failed")));
	});
	bus.on("question:request:v1", (event) => { secondClaim = event.claim(); });
	await assert.rejects(tools.get("question").execute("id", params, undefined, undefined,
		{ mode: "tui", ui: { custom() { assert.fail("fallback after claim"); } } }), /transport failed/);
	assert.equal(secondClaim, undefined);
});

integration("late route claims are refused after standalone fallback", async () => {
	const tools = new Map(), bus = createEventBus(); question({ events: bus, registerTool: (tool) => tools.set(tool.name, tool) });
	let lateClaim;
	bus.on("question:request:v1", async (event) => { await Promise.resolve(); lateClaim = event.claim(); });
	const result = await tools.get("question").execute("id", params, undefined, undefined,
		{ mode: "tui", ui: { custom: async () => null } });
	assert.equal(lateClaim, undefined);
	assert.equal(result.content[0].text, "User cancelled the selection");
});

integration("remote CLI relay forwards correlated answers and imports pending-input wait acknowledgements", async (t) => {
	const f = fixture(t);
	const input = { version: 1, handle: "abc123", requestId: randomUUID(), question: "Remote?",
		options: [{ label: "Yes", description: "On the host" }], createdAt: new Date().toISOString() };
	updateMetadata(f.runDir, { host: "fake-host" });
	const logPath = join(f.root, "ssh.log");
	// Fake SSH: inspect answer quoting and run the actual wait/status CLI in a separate
	// host directory. Answer acceptance is covered by the live inbox test above.
	const remoteDir = join(f.root, "remote-agent"), remoteRunDir = join(remoteDir, "subagents", "abc123");
	writeMetadata({ ...f.metadata, runDir: remoteRunDir });
	writePendingInput(remoteRunDir, input);
	writeFileSync(join(f.root, "bin", "ssh"), `#!/bin/sh\nfor arg do command="$arg"; done\nprintf '%s\\n' "$command" >> '${logPath}'\ncase "$command" in\n  *" answer "*) printf 'relayed answer\\n';;\n  *" wait "*) PI_CODING_AGENT_DIR='${remoteDir}' PI_SESSION_ID=parent '${process.execPath}' '${cliPath}' wait abc123 --timeout 1;;\n  *" status "*) PI_CODING_AGENT_DIR='${remoteDir}' '${process.execPath}' '${cliPath}' status abc123 --json;;\n  *) exit 1;;\nesac\n`, { mode: 0o700 });
	const status = await f.cli("status", "abc123", "--json");
	assert.equal(status.code, 0, status.stderr);
	assert.deepEqual(JSON.parse(status.stdout).pendingInput, input);
	const waiting = await f.cli("wait", "abc123", "--timeout", "1");
	assert.equal(waiting.code, WAIT_NEEDS_INPUT_EXIT, waiting.stderr); // The host's status is passed on.
	assert.match(waiting.stdout, /task NOT complete/);
	assert.equal(inputAcknowledged(f.runDir, input.requestId), true);
	assert.equal(readMetadata(f.runDir).parentNotifiedSettledAt, undefined);
	const answer = await f.cli("answer", "abc123", input.requestId, "--text", "don't use $HOME; wait");
	assert.equal(answer.code, 0, answer.stderr);
	const commands = readFileSync(logPath, "utf8");
	assert.match(commands, /PI_SESSION_ID='parent'/);
	assert.ok(commands.includes(`'${input.requestId}' '--text' 'don'\\''t use $HOME; wait'`));
});

integration("a reply queued ahead of the close message cannot resolve the tool once stop has marked the run", async (t) => {
	const f = fixture(t), child = await harness(t, f, { child: true });
	const result = child.ask(); const failed = assert.rejects(result, /supervisor close/);
	const request = readPendingInput(f.runDir), replyId = randomUUID();
	mkdirSync(join(f.runDir, "inbox"));
	// The inbox is consumed in file-name order: the answer sorts before the close message.
	writeFileSync(join(f.runDir, "inbox", `0-${replyId}.json`), JSON.stringify({ delivery: "answer", handle: "abc123",
		requestId: request.requestId, replyId, parentSessionId: "parent", answer: { kind: "option", option: 1 } }));
	writeFileSync(join(f.runDir, "inbox", "1-close.json"), JSON.stringify({ delivery: "close", message: "cleanup" }));
	updateMetadata(f.runDir, { state: "closing", closing: true }); // What `stop` writes before it queues the close.
	await child.tick(); await failed;
	const receipt = JSON.parse(readFileSync(answerReceiptPath(f.runDir, replyId), "utf8"));
	assert.equal(receipt.accepted, false);
	assert.match(receipt.error, /closing this run/);
	assert.equal(readPendingInput(f.runDir), undefined);
	assert.deepEqual(child.prompts, [{ message: "cleanup", options: { deliverAs: "followUp" } }]);
});

/** A remote run whose fake ssh answers the three relayed verbs as the given shell fragments say. */
function remoteRelay(f, { answer, status }) {
	updateMetadata(f.runDir, { host: "fake-host" });
	const input = { version: 1, handle: "abc123", requestId: randomUUID(), question: "Remote?",
		options: [{ label: "Yes" }], createdAt: new Date().toISOString() };
	writePendingInput(f.runDir, input);
	writeFileSync(join(f.root, "bin", "ssh"), `#!/bin/sh\nfor arg do command="$arg"; done\ncase "$command" in\n  *" answer "*) ${answer};;\n  *" status "*) ${status};;\n  *) exit 1;;\nesac\n`, { mode: 0o700 });
	return input;
}

test("an answer the host accepted stays a success when the status refresh after it fails", async (t) => {
	const f = fixture(t);
	const input = remoteRelay(f, { answer: "printf 'Answered abc123 on the host\\n'", status: "echo 'ssh: connection lost' >&2; exit 255" });
	const answer = await f.cli("answer", "abc123", input.requestId, "--option", "1");
	assert.equal(answer.code, 0, answer.stderr);
	assert.match(answer.stdout, /Answered abc123 on the host/);
	assert.equal(inputAcknowledged(f.runDir, input.requestId), true);
	// A status answer that is not a run record does not fail it either.
	const other = fixture(t);
	const again = remoteRelay(other, { answer: "printf 'Answered abc123 on the host\\n'", status: "echo 'not json'" });
	assert.equal((await other.cli("answer", "abc123", again.requestId, "--option", "1")).code, 0);
	// Nor does a local acknowledgement that cannot be written.
	const blocked = fixture(t);
	const third = remoteRelay(blocked, { answer: "printf 'Answered abc123 on the host\\n'", status: "exit 1" });
	writeFileSync(join(blocked.runDir, "input-acks"), "a file where the directory belongs");
	const accepted = await blocked.cli("answer", "abc123", third.requestId, "--option", "1");
	assert.equal(accepted.code, 0, accepted.stderr);
	assert.match(accepted.stdout, /Answered abc123 on the host/);
});

test("a connection that fails during the relay is uncertain delivery, not the host's refusal", async (t) => {
	const f = fixture(t);
	const input = remoteRelay(f, { answer: "echo 'Connection reset by peer' >&2; exit 255", status: "exit 255" });
	const answer = await f.cli("answer", "abc123", input.requestId, "--option", "1");
	assert.equal(answer.code, 1);
	assert.match(answer.stderr, /Connection reset by peer/);
	assert.match(answer.stderr, /delivery is uncertain/);
	assert.equal(inputAcknowledged(f.runDir, input.requestId), false);
});

test("an answer the host refused is a failure that carries the host's reason", async (t) => {
	const f = fixture(t);
	const input = remoteRelay(f, { answer: "echo 'Stale or wrong question request' >&2; exit 1", status: "exit 1" });
	const answer = await f.cli("answer", "abc123", input.requestId, "--option", "1");
	assert.equal(answer.code, 1);
	assert.match(answer.stderr, /Stale or wrong question request/);
	assert.doesNotMatch(answer.stderr, /uncertain/);
	assert.equal(inputAcknowledged(f.runDir, input.requestId), false);
});

test("a remote command with no answer inside its limit, or a failed connection, gives no verdict; a host's refusal does", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.root, "bin", "ssh"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
	const started = Date.now();
	const hung = await runRemoteBounded("fake-host", "answer", { timeoutMs: 300 });
	assert.ok(Date.now() - started < 5000, "the call ended at its limit");
	assert.deepEqual({ ok: hung.ok, noVerdict: hung.noVerdict }, { ok: false, noVerdict: true });
	writeFileSync(join(f.root, "bin", "ssh"), "#!/bin/sh\necho 'ssh: connect to host fake-host port 22: Connection refused' >&2; exit 255\n", { mode: 0o700 });
	const lost = await runRemoteBounded("fake-host", "answer", { timeoutMs: 5000 });
	assert.deepEqual({ ok: lost.ok, noVerdict: lost.noVerdict }, { ok: false, noVerdict: true });
	writeFileSync(join(f.root, "bin", "ssh"), "#!/bin/sh\necho 'no such run' >&2; exit 1\n", { mode: 0o700 });
	const refused = await runRemoteBounded("fake-host", "answer", { timeoutMs: 5000 });
	assert.deepEqual({ ok: refused.ok, noVerdict: refused.noVerdict, failure: refused.failure },
		{ ok: false, noVerdict: false, failure: "no such run" });
});

test("parent metadata writes and delayed acknowledgements cannot resurrect cancelled input", (t) => {
	const f = fixture(t), bridge = new QuestionBridge(f.runDir);
	let cancelled;
	bridge.request({ question: "Test?", options: [{ label: "Yes" }], claim: () => ({ resolve() {}, reject: (e) => { cancelled = e; } }) }, f.metadata);
	const stale = readMetadata(f.runDir), id = stale.pendingInput.requestId;
	bridge.cancel("cancelled");
	writeMetadata({ ...stale, parentNotifiedSettledAt: "settled" });
	acknowledgeInput(f.runDir, id);
	assert.equal(cancelled.message, "cancelled");
	assert.equal(readMetadata(f.runDir).pendingInput, undefined);
	assert.equal(readMetadata(f.runDir).parentNotifiedSettledAt, "settled");
	assert.equal(JSON.parse(readFileSync(join(f.runDir, "metadata.json"), "utf8")).pendingInput, undefined);
});

test("remote relay snapshots retain descriptions and acknowledgements without changing busy/completion state", (t) => {
	const f = fixture(t), input = { version: 1, handle: "abc123", requestId: randomUUID(), question: "Remote?",
		options: [{ label: "Yes", description: "Remote description" }], createdAt: new Date().toISOString() };
	updateMetadata(f.runDir, { host: "fake-host" });
	const local = readMetadata(f.runDir);
	syncRemoteRun(local, { ...f.metadata, pendingInput: input });
	let snapshot = readMetadata(f.runDir);
	assert.equal(snapshot.state, "busy");
	assert.equal(snapshot.settledAt, undefined);
	assert.equal(displayRunState(snapshot), "waiting-input");
	assert.deepEqual(activeInput(snapshot), input);
	syncRemoteRun(local, { ...f.metadata, pendingInput: input, parentNotifiedInputId: input.requestId });
	assert.equal(inputAcknowledged(f.runDir, input.requestId), true);
	syncRemoteRun(local, { ...f.metadata, pendingInput: undefined });
	assert.equal(readMetadata(f.runDir).pendingInput, undefined);
	// A stale remote snapshot may be shown until refresh, but cannot repeat a delivered wake-up.
	syncRemoteRun(local, { ...f.metadata, pendingInput: input });
	snapshot = readMetadata(f.runDir);
	assert.equal(snapshot.parentNotifiedInputId, input.requestId);
	assert.equal(activeInput({ ...snapshot, state: "exited" }), undefined);
	assert.equal(activeInput({ ...snapshot, closing: true }), undefined);
});
