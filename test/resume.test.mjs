import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readMetadata, writeMetadata } from "../shared.ts";

const cli = resolve(import.meta.dirname, "../subagent.ts");
function fixture(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-resume-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runDir = join(root, "subagents", "abc123");
	const bin = join(root, "bin");
	mkdirSync(bin);
	const run = { version: 1, handle: "abc123", name: "study", parentSessionId: "parent", childSessionId: "child", runDir,
		tmuxSession: "pi-subagent-abc123", sessionFile: join(root, "child.jsonl"), cwd: root, provider: "test", model: "model",
		thinking: "high", launchArgs: ["--no-skills"], state: "busy", hasStarted: true, settledAt: "old", paneId: "%1",
		createdAt: "2026-01-01", updatedAt: "2026-01-02" };
	writeMetadata(run);
	writeFileSync(run.sessionFile, JSON.stringify({ type: "session", id: "child", cwd: root }) + "\n");
	const env = { ...process.env, PI_SESSION_ID: "parent", PI_SUBAGENT_RUN_DIR: "", PI_CODING_AGENT_DIR: root,
		PATH: bin + ":" + process.env.PATH };
	const call = (args, patch = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...env, ...patch }, timeout: 8000 });
	const tmux = body => writeFileSync(join(bin, "tmux"), "#!/bin/sh\n" + body, { mode: 0o700 });
	tmux('echo "$1" >> "$PI_CODING_AGENT_DIR/tmux.calls"; exit 1');
	return { root, run, call, tmux, calls: () => { try { return readFileSync(join(root, "tmux.calls"), "utf8"); } catch { return ""; } } };
}

test("list and status JSON expose a lost pane as exited without deleting its recovery record", t => {
	const { run, call } = fixture(t);
	assert.equal(JSON.parse(call(["status", run.handle, "--json"]).stdout).state, "exited");
	assert.equal(JSON.parse(call(["list", "--json"]).stdout)[0].state, "exited");
	assert.equal(readMetadata(run.runDir).state, "busy");
});

test("resume refuses non-owners, running or closing runs, and unavailable session evidence", t => {
	const { run, call, tmux, calls } = fixture(t);
	const resume = (...env) => call(["resume", run.handle], ...env);
	assert.match(resume({ PI_SESSION_ID: "someone else" }).stderr, /dispatching Pi session/);
	assert.match(resume({ PI_SESSION_ID: "" }).stderr, /dispatching Pi session/);
	assert.match(resume({ PI_SUBAGENT_RESUME_CREATED_AT: "different run" }).stderr, /not the original/);
	assert.equal(calls(), "");
	tmux('if [ "$1" = has-session ]; then exit 0; fi; exit 1');
	assert.match(resume().stderr, /already running/);
	tmux('echo "$1" >> "$PI_CODING_AGENT_DIR/tmux.calls"; exit 1');
	writeMetadata({ ...run, closing: true });
	assert.match(resume().stderr, /stopp|closing/);
	writeMetadata(run);
	for (const bytes of ["", "not JSON\n", '{"type":"session","id":"other","cwd":"/"}\n']) {
		writeFileSync(run.sessionFile, bytes);
		assert.equal(resume().status, 1);
		assert.equal(readFileSync(run.sessionFile, "utf8"), bytes);
	}
	rmSync(run.sessionFile);
	assert.match(resume().stderr, /session|transcript/i);
	assert.doesNotMatch(calls(), /new-session/);
	rmSync(run.runDir, { recursive: true });
	assert.match(resume().stderr, /Unknown subagent/);
});

test("pending pre-loss work is not replayed silently", t => {
	const { run, call, calls } = fixture(t);
	mkdirSync(join(run.runDir, "inbox"));
	const file = join(run.runDir, "inbox", "prior.json");
	writeFileSync(file, '{"delivery":"followUp","message":"old"}');
	assert.match(call(["resume", run.handle]).stderr, /inbox/);
	assert.match(readFileSync(file,"utf8"), /old/);
	assert.doesNotMatch(calls(), /new-session/);
});

test("the original parent resumes on the execution host from its current file, not the shadow's paths or prompt", t => {
	const { run, root, call, tmux } = fixture(t);
	const hostRoot = join(root, "worker");
	const hostDir = join(hostRoot, "subagents", run.handle);
	const file = join(hostDir, "saved.jsonl");
	const host = { ...run, cwd: hostRoot, runDir: hostDir, sessionFile: file };
	writeMetadata(host);
	const bytes = readFileSync(run.sessionFile);
	writeFileSync(file, bytes);
	writeMetadata({ ...run, host: "worker", sessionFile: "/remote/path/at/spawn", remoteCwd: hostRoot });
	const log = join(root, "argv.json"), alive = join(root, "alive");
	// Only replace transport and the terminal. Run the host CLI itself against a separate store.
	writeFileSync(join(root, "bin", "ssh"), `#!/bin/sh\nfor a do cmd="$a"; done\nexport PI_CODING_AGENT_DIR='${hostRoot}'\nunset PI_SESSION_ID\nexec /bin/sh -c "$(printf '%s' "$cmd" | sed 's|~/.pi/agent/bin/subagent|${cli}|')"\n`, { mode: 0o700 });
	tmux(`if [ "$1" = has-session ]; then test -f '${alive}'; exit $?; fi\n[ "$1" = new-session ] || exit 1\nexec '${process.execPath}' '${join(root, "ready.cjs")}' "$@"`);
	writeFileSync(join(root, "ready.cjs"), `const fs=require('node:fs'), args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(args));fs.writeFileSync(${JSON.stringify(alive)},'');\nconst f=${JSON.stringify(join(hostDir,"metadata.json"))}, m=JSON.parse(fs.readFileSync(f));Object.assign(m,{resumedLaunch:args.find(a=>a.startsWith('PI_SUBAGENT_RESUMING=')).split('=')[1],state:'idle',hasStarted:false,paneId:'%12'});delete m.settledAt;fs.writeFileSync(f,JSON.stringify(m));console.log('%12');`);
	// A workspace launcher appearing after the child was spawned is not part of its saved launch settings.
	writeFileSync(join(hostRoot, "pi-test.sh"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	const result = call(["resume", run.handle, "--json"]);
	assert.equal(result.status, 0, result.stderr);
	const out = JSON.parse(result.stdout), args = JSON.parse(readFileSync(log));
	assert.equal(args[args.indexOf("--session") - 1], "pi");
	assert.deepEqual(args.slice(args.indexOf("--session")), ["--session",file,"--provider",host.provider,"--model",host.model,"--thinking",host.thinking,"--no-skills"]);
	assert.ok(args.includes(`PI_SUBAGENT_RUN_DIR=${hostDir}`));
	assert.equal(args[args.indexOf("-c")+1], hostRoot);
	assert.deepEqual([out.handle,out.host,out.childSessionId,out.paneId,out.sessionFile,out.cwd,out.runDir,out.hasStarted],
		[run.handle,"worker","child","%12",file,root,run.runDir,false]);
	assert.equal(readMetadata(run.runDir).paneId, "%12");
	assert.deepEqual(readFileSync(file), bytes);
	assert.equal(existsSync(join(hostDir,"inbox")), false);
	assert.match(call(["resume", run.handle]).stderr, /already running/);
});

test("a remote resume requires the host's verdict; a transport failure cannot launch locally", t => {
	const { run, root, call, calls } = fixture(t);
	writeMetadata({ ...run, host: "unreachable", state: "exited" });
	writeFileSync(join(root, "bin", "ssh"), '#!/bin/sh\nexit 255\n', { mode: 0o700 });
	const result = call(["resume", run.handle]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /uncertain|not confirmed/);
	assert.equal(readMetadata(run.runDir).state, "exited");
	assert.equal(calls(), "");
});
