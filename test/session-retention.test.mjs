import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createRun, createSessionFile, readLatestAssistant, readMetadata, removeRunDir, writeMetadata } from "../shared.ts";

const cliPath = resolve(import.meta.dirname, "../subagent.ts");
const transcript = `${JSON.stringify({ type: "session", version: 3, id: "child", cwd: "/repo" })}\n${JSON.stringify({ type: "message", id: "result", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "The remedy requires preparation before startup, not afterward." }], stopReason: "stop" } })}\n`;

function fixture(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-session-retention-")));
	const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR };
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(root, { recursive: true, force: true });
	});
	const runDir = join(root, "subagents", "abc123");
	const metadata = { version: 1, handle: "abc123", parentSessionId: "parent", tmuxSession: "fake", runDir,
		sessionFile: join(runDir, "session.jsonl"), cwd: root, provider: "test", model: "test", thinking: "off",
		state: "exited", hasStarted: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
	return { root, runDir, metadata };
}

test("new session paths remain private, stable and readable after control cleanup", t => {
	const f = fixture(t);
	const sessionFile = createSessionFile("abc123");
	assert.ok(sessionFile.startsWith(join(f.root, "sessions", "subagents")));
	assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
	writeFileSync(sessionFile, transcript);
	writeMetadata({ ...f.metadata, sessionFile });
	assert.equal(removeRunDir(f.runDir), sessionFile);
	assert.equal(existsSync(f.runDir), false);
	assert.equal(readFileSync(sessionFile, "utf8"), transcript);
	assert.equal(readLatestAssistant(sessionFile).content[0].text, "The remedy requires preparation before startup, not afterward.");
});

test("in-run transcripts are retained byte-for-byte before the run directory is removed", t => {
	const f = fixture(t);
	writeMetadata(f.metadata);
	writeFileSync(f.metadata.sessionFile, transcript, { mode: 0o600 });
	const retained = removeRunDir(f.runDir);
	assert.ok(retained.startsWith(join(f.root, "sessions", "subagents", "abc123-")));
	assert.equal(existsSync(f.runDir), false);
	assert.equal(readFileSync(retained, "utf8"), transcript);
	assert.equal(removeRunDir(f.runDir), undefined);
	assert.equal(readFileSync(retained, "utf8"), transcript);
});

test("failed archival leaves the original transcript and control state intact", t => {
	const f = fixture(t);
	writeMetadata(f.metadata);
	writeFileSync(f.metadata.sessionFile, transcript);
	writeFileSync(join(f.root, "sessions"), "not a directory");
	assert.throws(() => removeRunDir(f.runDir));
	assert.equal(readFileSync(f.metadata.sessionFile, "utf8"), transcript);
	assert.equal(readMetadata(f.runDir).handle, "abc123");
});

test("missing or corrupt control metadata cannot delete an unarchived transcript", t => {
	const f = fixture(t);
	writeMetadata(f.metadata);
	writeFileSync(f.metadata.sessionFile, transcript);
	for (const body of ["invalid JSON", null]) {
		if (body === null) rmSync(join(f.runDir, "metadata.json"));
		else writeFileSync(join(f.runDir, "metadata.json"), body);
		assert.throws(() => removeRunDir(f.runDir), /metadata is missing or unreadable/);
		assert.equal(readFileSync(f.metadata.sessionFile, "utf8"), transcript);
	}
});

test("concurrent teardown can finish after metadata was read without losing an external session", t => {
	const f = fixture(t), sessionFile = createSessionFile("abc123");
	writeMetadata({ ...f.metadata, sessionFile });
	writeFileSync(sessionFile, transcript);
	const original = fs.readFileSync;
	let nested = false;
	fs.readFileSync = (path, ...args) => {
		const result = original(path, ...args);
		if (!nested && String(path) === join(f.runDir, "metadata.json")) { nested = true; removeRunDir(f.runDir); }
		return result;
	};
	syncBuiltinESMExports();
	try { assert.equal(removeRunDir(f.runDir), sessionFile); }
	finally { fs.readFileSync = original; syncBuiltinESMExports(); }
	assert.equal(readFileSync(sessionFile, "utf8"), transcript);
});

test("legacy transcript disappearance after its existence check confirms completed teardown", t => {
	const f = fixture(t);
	writeMetadata(f.metadata); writeFileSync(f.metadata.sessionFile, transcript);
	const original = fs.realpathSync;
	let nested = false, archive;
	fs.realpathSync = (path, ...args) => {
		if (!nested && String(path) === f.metadata.sessionFile) { nested = true; archive = removeRunDir(f.runDir); }
		return original(path, ...args);
	};
	syncBuiltinESMExports();
	try { assert.equal(removeRunDir(f.runDir), undefined); }
	finally { fs.realpathSync = original; syncBuiltinESMExports(); }
	assert.equal(readFileSync(archive, "utf8"), transcript);
	assert.equal(existsSync(f.runDir), false);
});

test("allocation and metadata failures roll back only the startup resources they own", t => {
	const f = fixture(t);
	const setup = { handle: "abc123", cwd: f.root, provider: "test", model: "test", thinking: "off" };
	writeFileSync(join(f.root, "sessions"), "blocks allocation");
	assert.throws(() => createRun(setup));
	assert.equal(existsSync(f.runDir), false);
	rmSync(join(f.root, "sessions"));
	const original = fs.writeFileSync;
	fs.writeFileSync = (path, ...args) => {
		if (String(path).includes("metadata.json")) throw new Error("metadata write failed");
		return original(path, ...args);
	};
	syncBuiltinESMExports();
	try { assert.throws(() => createRun(setup), /metadata write failed/); }
	finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
	assert.equal(existsSync(f.runDir), false);
	assert.equal(fs.readdirSync(join(f.root, "sessions", "subagents")).length, 0);
});

test("a conflicting archive cannot overwrite evidence or authorize control deletion", t => {
	const f = fixture(t);
	writeMetadata(f.metadata);
	writeFileSync(f.metadata.sessionFile, transcript);
	const first = removeRunDir(f.runDir);
	writeMetadata(f.metadata);
	writeFileSync(f.metadata.sessionFile, "different evidence");
	assert.throws(() => removeRunDir(f.runDir), /Refusing to overwrite/);
	assert.equal(readFileSync(first, "utf8"), transcript);
	assert.equal(readFileSync(f.metadata.sessionFile, "utf8"), "different evidence");
});

test("startup failures do not leave empty owned transcripts; remote shadows touch no local evidence", t => {
	const f = fixture(t);
	const empty = createSessionFile("abc123");
	writeMetadata({ ...f.metadata, sessionFile: empty });
	removeRunDir(f.runDir);
	assert.equal(existsSync(empty), false);
	const external = join(f.root, "remote-lookalike.jsonl");
	writeFileSync(external, transcript);
	writeMetadata({ ...f.metadata, host: "remote", sessionFile: external });
	assert.equal(removeRunDir(f.runDir), undefined);
	assert.equal(readFileSync(external, "utf8"), transcript);
});

test("CLI spawn exposes the stable transcript path and force stop retains it for fallback", t => {
	const f = fixture(t);
	const bin = join(f.root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "tmux"), '#!/bin/sh\nif [ "$1" = "has-session" ]; then exit 1; fi\nif [ "$1" = "new-session" ]; then printf "%s\\n" "%0"; fi\nexit 0\n', { mode: 0o700 });
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_SUBAGENT_RUN_DIR: "", PI_SESSION_ID: "parent" };
	const call = (...args) => execFileSync(process.execPath, [cliPath, ...args], { env, encoding: "utf8", timeout: 10000 });
	const spawned = call("spawn", "--name", "retention-test", "--provider", "test", "--model", "test", "--cwd", f.root, "--prompt", "No model is launched by the mock");
	const handle = /\(([a-z0-9]+)\)/.exec(spawned)[1];
	const metadata = JSON.parse(call("status", handle, "--json"));
	assert.ok(spawned.includes(`Transcript: ${metadata.sessionFile}\n`));
	assert.ok(!metadata.sessionFile.startsWith(metadata.runDir));
	writeFileSync(metadata.sessionFile, transcript);
	const stopped = call("stop", handle, "--force");
	assert.ok(stopped.includes(`Transcript kept: ${metadata.sessionFile}`));
	assert.equal(existsSync(metadata.runDir), false);
	assert.equal(readFileSync(metadata.sessionFile, "utf8"), transcript);
});

test("a run spawned to discard its transcript deletes only its own archived file at teardown", t => {
	const f = fixture(t);
	const sessionFile = createSessionFile("abc123");
	writeFileSync(sessionFile, transcript);
	writeMetadata({ ...f.metadata, sessionFile, discardTranscript: true });
	assert.equal(removeRunDir(f.runDir), undefined);
	assert.equal(existsSync(sessionFile), false);
	assert.equal(existsSync(f.runDir), false);
	// A path outside session storage is never deleted on the run's behalf.
	const external = join(f.root, "elsewhere.jsonl");
	writeFileSync(external, transcript);
	writeMetadata({ ...f.metadata, sessionFile: external, discardTranscript: true });
	assert.equal(removeRunDir(f.runDir), undefined);
	assert.equal(readFileSync(external, "utf8"), transcript);
});

test("CLI spawn --discard-transcript marks the run and stop deletes the transcript", t => {
	const f = fixture(t);
	const bin = join(f.root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "tmux"), '#!/bin/sh\nif [ "$1" = "has-session" ]; then exit 1; fi\nif [ "$1" = "new-session" ]; then printf "%s\\n" "%0"; fi\nexit 0\n', { mode: 0o700 });
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_SUBAGENT_RUN_DIR: "", PI_SESSION_ID: "parent" };
	const call = (...args) => execFileSync(process.execPath, [cliPath, ...args], { env, encoding: "utf8", timeout: 10000 });
	const spawned = call("spawn", "--discard-transcript", "--provider", "test", "--model", "test", "--cwd", f.root, "--prompt", "No model is launched by the mock");
	const handle = /\(([a-z0-9]+)\)/.exec(spawned)?.[1] ?? /Spawned ([a-z0-9]+)/.exec(spawned)[1];
	const metadata = JSON.parse(call("status", handle, "--json"));
	assert.equal(metadata.discardTranscript, true);
	assert.ok(spawned.includes(`Transcript: ${metadata.sessionFile} (deleted at stop)\n`));
	writeFileSync(metadata.sessionFile, transcript);
	const stopped = call("stop", handle, "--force");
	assert.ok(stopped.includes("Transcript deleted."));
	assert.equal(existsSync(metadata.sessionFile), false);
	assert.equal(existsSync(metadata.runDir), false);
});
