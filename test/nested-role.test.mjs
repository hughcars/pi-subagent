import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { launchRun, OWNER_PID_ENV, readMetadata, subagentRole, writeMetadata } from "../shared.ts";

const sharedUrl = JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../shared.ts")).href);

test("only the first Pi process of a managed run is its child, also after a reload", () => {
	assert.deepEqual(subagentRole({}, 10), { kind: "parent" });
	const env = { PI_SUBAGENT_RUN_DIR: "/runs/abc123" };
	assert.deepEqual(subagentRole(env, 10), { kind: "child", runDir: "/runs/abc123" });
	assert.equal(env[OWNER_PID_ENV], "10");
	assert.deepEqual(subagentRole(env, 10), { kind: "child", runDir: "/runs/abc123" });
	const inherited = { ...env };
	assert.deepEqual(subagentRole(inherited, 11), { kind: "nested" });
	assert.deepEqual(inherited, env);
});

test("a process started by the child inherits the run directory and is nested", () => {
	// The child process records its pid; its own child (a `pi` from the bash tool, say) gets both.
	const grandchild = `const { subagentRole } = await import(${sharedUrl}); console.log(subagentRole().kind);`;
	const child = `
		const { subagentRole } = await import(${sharedUrl});
		const { spawnSync } = await import("node:child_process");
		const role = subagentRole().kind;
		const out = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(grandchild)}], { encoding: "utf8" });
		console.log(JSON.stringify({ role, grandchild: out.stdout.trim(), stderr: out.stderr }));`;
	const env = { ...process.env, PI_SUBAGENT_RUN_DIR: "/runs/abc123" };
	delete env[OWNER_PID_ENV];
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8", env, timeout: 20000 });
	assert.equal(result.status, 0, result.stderr);
	const seen = JSON.parse(result.stdout);
	assert.equal(seen.role, "child", seen.stderr);
	assert.equal(seen.grandchild, "nested", seen.stderr);
});

test("launchRun clears an owner pid the tmux server may carry", t => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-nested-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const run = { version: 1, handle: "abc123", name: "study", parentSessionId: "parent", runDir: join(root, "run"),
		tmuxSession: "pi-subagent-abc123", sessionFile: join(root, "child.jsonl"), cwd: root, provider: "test",
		model: "model", thinking: "high", state: "starting", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
	writeMetadata(run);
	writeFileSync(join(root, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(root, "tmux.args")}'\necho %7\n`, { mode: 0o700 });
	const savedPath = process.env.PATH;
	process.env.PATH = `${root}:${savedPath}`;
	try {
		launchRun(run);
	} finally {
		process.env.PATH = savedPath;
	}
	const args = readFileSync(join(root, "tmux.args"), "utf8").split("\n");
	const at = args.indexOf("env");
	assert.deepEqual(args.slice(at, at + 4), ["env", "-u", OWNER_PID_ENV, `PI_SUBAGENT_RUN_DIR=${run.runDir}`]);
	assert.equal(readMetadata(run.runDir).paneId, "%7");
});
