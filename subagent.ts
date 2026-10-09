#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assistantText,
	effectiveRunState,
	getAgentDir,
	getRunsDir,
	inboxDir,
	isRemote,
	launchRun,
	loadHosts,
	listRuns,
	readLatestAssistant,
	readMetadata,
	REMOTE_CLI,
	remoteAttachCommand,
	removeRunDir,
	runDisplayName,
	runRemote,
	isValidRunName,
	type HostConfig,
	type InboxMessage,
	type RunMetadata,
	SSH_OPTIONS,
	shq,
	tmuxSessionExists,
	updateMetadata,
	waitForRunShutdown,
	writeMetadata,
} from "./shared.ts";

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

function fail(message: string): never {
	throw new Error(message);
}

function usage(): never {
	fail(`Usage:
  subagent spawn [--name <name>] [--provider <provider>] [--model <model>] [--thinking <level>]
    [--cwd <dir>] [--tools <names>] [--no-extensions] [--no-skills]
    [--no-prompt-templates] [--no-context-files] (--prompt <text> | --file <path>)...
  subagent status <handle> [--json]
  subagent rename <handle> <name>
  subagent send <handle> [--follow-up] <message>
  subagent wait <handle> [--timeout <seconds>]
  subagent stop <handle>
  subagent fetch <handle> [dest]
  subagent list [--json]

Remote hosts:
  subagent spawn --host <ssh-alias> [--remote-cwd <dir>] ...   rsyncs --cwd to the host first
  Remote runs appear in list and /subagent like local ones; fetch copies results back.
  Hosts are configured in ${join(getAgentDir(), "subagent.json")} as
  { "hosts": { "<ssh-alias>": { "remoteRoot": "<dir>", "syncExcludes": ["..."] } } }`);
}

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) fail(`${option} requires a value`);
	return value;
}

function normalizeRunName(value: string): string {
	const name = value.trim();
	if (!isValidRunName(name)) fail("Subagent name must be a single line of 1 to 64 characters");
	return name;
}

function runDirForHandle(handle: string): string {
	if (!/^[a-z0-9]+$/.test(handle)) fail(`Invalid subagent handle: ${handle}`);
	return join(getRunsDir(), handle);
}

function getRun(handle: string): RunMetadata {
	const metadata = readMetadata(runDirForHandle(handle));
	if (!metadata) fail(`Unknown subagent: ${handle}`);
	return metadata;
}

function generateHandle(): string {
	mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = randomBytes(3).toString("hex");
		if (!existsSync(runDirForHandle(handle))) return handle;
	}
	fail("Could not allocate a unique subagent handle");
}

function spawnSubagent(args: string[]): void {
	if (process.env.PI_SUBAGENT_RUN_DIR) fail("Nested subagents are disabled");
	let name: string | undefined;
	let host: string | undefined;
	let remoteCwd: string | undefined;
	let provider = process.env.PI_PROVIDER;
	let model = process.env.PI_MODEL;
	let thinking = process.env.PI_REASONING_LEVEL || "medium";
	// Explicit flags must win over per-host defaults in remote spawns; ambient env must not.
	let providerExplicit = false;
	let modelExplicit = false;
	let thinkingExplicit = false;
	let cwd = process.cwd();
	let tools: string | undefined;
	let noExtensions = false;
	let noSkills = false;
	let noPromptTemplates = false;
	let noContextFiles = false;
	const prompts: string[] = [];
	const files: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--name":
				name = normalizeRunName(valueAfter(args, i, arg));
				i++;
				break;
			case "--host":
				host = valueAfter(args, i, arg);
				i++;
				break;
			case "--remote-cwd":
				remoteCwd = valueAfter(args, i, arg);
				i++;
				break;
			case "--provider":
				provider = valueAfter(args, i, arg);
				providerExplicit = true;
				i++;
				break;
			case "--model":
				model = valueAfter(args, i, arg);
				modelExplicit = true;
				i++;
				break;
			case "--thinking":
				thinking = valueAfter(args, i, arg);
				thinkingExplicit = true;
				i++;
				break;
			case "--cwd":
				cwd = resolve(valueAfter(args, i, arg));
				i++;
				break;
			case "--tools":
				tools = valueAfter(args, i, arg);
				i++;
				break;
			case "--no-extensions":
				noExtensions = true;
				break;
			case "--no-skills":
				noSkills = true;
				break;
			case "--no-prompt-templates":
				noPromptTemplates = true;
				break;
			case "--no-context-files":
				noContextFiles = true;
				break;
			case "--prompt":
				prompts.push(valueAfter(args, i, arg));
				i++;
				break;
			case "--file": {
				const file = resolve(valueAfter(args, i, arg));
				if (!existsSync(file)) fail(`File not found: ${file}`);
				files.push(file);
				i++;
				break;
			}
			default:
				fail(`Unknown spawn argument: ${arg}`);
		}
	}

	if (!provider) fail("No provider specified and PI_PROVIDER is not set");
	if (!model) fail("No model specified and PI_MODEL is not set");
	if (!VALID_THINKING_LEVELS.has(thinking)) fail(`Invalid thinking level: ${thinking}`);
	if (tools !== undefined && !tools.split(",").some((name) => name.trim()))
		fail("--tools requires at least one tool name");
	if (prompts.length === 0 && files.length === 0) fail("spawn requires at least one --prompt or --file");
	if (!existsSync(cwd)) fail(`Working directory not found: ${cwd}`);

	if (host) {
		spawnRemoteSubagent(host, remoteCwd, {
			name,
			provider,
			model,
			thinking,
			providerExplicit,
			modelExplicit,
			thinkingExplicit,
			cwd,
			tools,
			noExtensions,
			noSkills,
			noPromptTemplates,
			noContextFiles,
			prompts,
			files,
		});
		return;
	}

	const handle = generateHandle();
	const runDir = runDirForHandle(handle);
	const sessionFile = join(runDir, "session.jsonl");
	const tmuxSession = `pi-subagent-${handle}`;
	mkdirSync(inboxDir(runDir), { recursive: true, mode: 0o700 });
	writeFileSync(sessionFile, "", { mode: 0o600 });

	const launchArgs: string[] = [];
	if (tools) launchArgs.push("--tools", tools);
	if (noExtensions) launchArgs.push("--no-extensions", "--extension", extensionPath);
	if (noSkills) launchArgs.push("--no-skills");
	if (noPromptTemplates) launchArgs.push("--no-prompt-templates");
	if (noContextFiles) launchArgs.push("--no-context-files");

	const now = new Date().toISOString();
	const metadata: RunMetadata = {
		version: 1,
		handle,
		name,
		parentSessionId: process.env.PI_SESSION_ID || undefined,
		parentSessionFile: process.env.PI_SESSION_FILE || undefined,
		tmuxSession,
		runDir,
		sessionFile,
		cwd,
		provider,
		model,
		thinking,
		launchArgs,
		state: "starting",
		hasStarted: false,
		createdAt: now,
		updatedAt: now,
	};
	writeMetadata(metadata);

	const initialArgs = files.map((file) => `@${file}`);
	if (prompts.length > 0) initialArgs.push(`Task:\n${prompts.join("\n\n")}`);
	try {
		launchRun(metadata, initialArgs);
	} catch (error) {
		removeRunDir(runDir);
		throw error;
	}

	process.stdout.write(`Spawned ${runDisplayName(metadata)}\nState: busy\nAttach: tmux attach -t ${tmuxSession}\n`);
}

const DEFAULT_SYNC_EXCLUDES = [".git", "node_modules", ".venv", "__pycache__"];

interface RemoteSpawnOptions {
	name?: string;
	provider: string;
	model: string;
	thinking: string;
	/** Whether --provider/--model/--thinking were passed explicitly (flags win over host defaults). */
	providerExplicit: boolean;
	modelExplicit: boolean;
	thinkingExplicit: boolean;
	cwd: string;
	tools?: string;
	noExtensions: boolean;
	noSkills: boolean;
	noPromptTemplates: boolean;
	noContextFiles: boolean;
	prompts: string[];
	files: string[];
}

function remoteHas(host: string, command: string): boolean {
	return spawnSync("ssh", [...SSH_OPTIONS, host, command], { stdio: "ignore" }).status === 0;
}

/** Ensure the host can run the CLI: pi, tmux, rsync, node present; extension copied and linked. */
function provisionRemote(host: string): void {
	const missing: string[] = [];
	const checks: Array<[string, string]> = [
		["pi", "command -v pi"],
		["tmux", "command -v tmux"],
		["rsync", "command -v rsync"],
		["node >= 22.19", `node -e ${shq("process.exit(process.versions.node >= '22.19.0' ? 0 : 1)")}`],
	];
	for (const [label, command] of checks) {
		if (!remoteHas(host, command)) missing.push(label);
	}
	if (missing.length > 0) {
		fail(`${host} is missing remote-subagent prerequisites: ${missing.join(", ")}`);
	}
	if (remoteHas(host, `test -x ${REMOTE_CLI}`)) return;
	const extensionDir = dirname(extensionPath);
	const copy = spawnSync("rsync", ["-a", "-e", "ssh", "--exclude", ".git", `${extensionDir}/`, `${host}:~/.pi/agent/extensions/subagent/`], { stdio: "inherit" });
	if (copy.status !== 0) fail(`Could not copy the subagent extension to ${host}`);
	runRemote(host, "mkdir -p ~/.pi/agent/bin && ln -sf ../extensions/subagent/subagent.ts ~/.pi/agent/bin/subagent");
}

/** rsync a local directory to a directory on the host. Both must be directories. */
function rsyncToHost(src: string, host: string, dest: string, excludes: string[]): void {
	const args = ["-a", "-e", "ssh"];
	for (const pattern of excludes) args.push("--exclude", pattern);
	args.push(`${src}/`, `${host}:${dest}/`);
	const result = spawnSync("rsync", args, { stdio: "inherit" });
	if (result.status !== 0) fail(`rsync to ${host} failed with exit code ${result.status}`);
}

function spawnRemoteSubagent(host: string, remoteCwdFlag: string | undefined, options: RemoteSpawnOptions): void {
	const hosts = loadHosts();
	const config = hosts[host];
	if (!config) {
		const known = Object.keys(hosts).join(", ") || "none configured";
		fail(`Unknown subagent host: ${host} (known: ${known}). Configure hosts in ${join(getAgentDir(), "subagent.json")}`);
	}
	// Explicit spawn flags win; otherwise a host default replaces the local ambient
	// provider/model, which may not exist on the remote machine.
	const provider = options.providerExplicit || !config.provider ? options.provider : config.provider;
	const model = options.modelExplicit || !config.model ? options.model : config.model;
	const thinking = options.thinkingExplicit || !config.thinking ? options.thinking : config.thinking;

	const srcDir = resolve(options.cwd);
	const remoteHome = runRemote(host, "echo $HOME").trim();
	const expandRemote = (path: string): string =>
		path === "~" ? remoteHome : path.startsWith("~/") ? `${remoteHome}/${path.slice(2)}` : path;
	const remoteBase = expandRemote(remoteCwdFlag ?? `${config.remoteRoot}/${basename(srcDir)}`);
	const excludes = [...DEFAULT_SYNC_EXCLUDES, ...(config.syncExcludes ?? [])];

	provisionRemote(host);
	// rsync only creates the last path component; create the full base first.
	runRemote(host, `mkdir -p ${shq(remoteBase)}`);
	rsyncToHost(srcDir, host, remoteBase, excludes);

	// Map --file arguments to paths on the host: files inside the synced tree keep their
	// relative location, anything else is copied into <remoteBase>/.subagent-files/.
	const remoteFiles: string[] = [];
	for (const file of options.files) {
		const resolvedFile = resolve(file);
		const rel = relative(srcDir, resolvedFile);
		if (rel && !rel.startsWith("..")) {
			remoteFiles.push(`${remoteBase}/${rel}`);
			continue;
		}
		const target = `${remoteBase}/.subagent-files/${basename(resolvedFile)}`;
		const copy = spawnSync("rsync", ["-a", "-e", "ssh", resolvedFile, `${host}:${target}`], { stdio: "ignore" });
		if (copy.status !== 0) fail(`Could not copy ${resolvedFile} to ${host}`);
		remoteFiles.push(target);
	}

	const cliArgs = [REMOTE_CLI, "spawn"];
	if (options.name) cliArgs.push("--name", options.name);
	cliArgs.push("--provider", provider, "--model", model, "--thinking", thinking);
	cliArgs.push("--cwd", remoteBase);
	if (options.tools) cliArgs.push("--tools", options.tools);
	if (options.noExtensions) cliArgs.push("--no-extensions");
	if (options.noSkills) cliArgs.push("--no-skills");
	if (options.noPromptTemplates) cliArgs.push("--no-prompt-templates");
	if (options.noContextFiles) cliArgs.push("--no-context-files");
	for (const prompt of options.prompts) cliArgs.push("--prompt", prompt);
	for (const file of remoteFiles) cliArgs.push("--file", file);
	const env = process.env.PI_SESSION_ID ? `PI_SESSION_ID=${shq(process.env.PI_SESSION_ID)} ` : "";
	// REMOTE_CLI stays unquoted so the remote shell expands its ~; every other argument is
	// single-quoted, including paths that contain spaces.
	const output = runRemote(host, `${env}${REMOTE_CLI} ${cliArgs.slice(1).map(shq).join(" ")}`);

	const handleMatch = /\(([a-z0-9]+)\)/.exec(output);
	if (!handleMatch) fail(`Could not parse spawn output from ${host}: ${output.trim()}`);
	const handle = handleMatch[1];
	const runDir = runDirForHandle(handle);
	if (existsSync(runDir)) fail(`Subagent handle collision: ${handle}`);

	// Mirror the remote metadata as a local shadow so list, /subagent and the widget treat
	// the run exactly like a local one; every verb dispatches on metadata.host.
	const remoteMeta = JSON.parse(
		runRemote(host, `${REMOTE_CLI} status ${shq(handle)} --json`),
	) as RunMetadata;
	const shadow: RunMetadata = {
		...remoteMeta,
		host,
		remoteCwd: remoteMeta.cwd,
		syncSource: srcDir,
		runDir,
		cwd: srcDir,
		provider,
		model,
		thinking,
		parentSessionId: process.env.PI_SESSION_ID || undefined,
		parentSessionFile: process.env.PI_SESSION_FILE || undefined,
	};
	writeMetadata(shadow);
	process.stdout.write(
		`Spawned ${runDisplayName(shadow)} on ${host}\nState: ${remoteMeta.state}\nAttach: ${remoteAttachCommand(shadow)}\n`,
	);
}

function statusSubagent(args: string[]): void {
	const asJson = args.includes("--json");
	const rest = args.filter((arg) => arg !== "--json");
	if (rest.length !== 1) usage();
	const metadata = getRun(rest[0]);
	if (isRemote(metadata)) {
		const remoteMeta = JSON.parse(
			runRemote(metadata.host as string, `${REMOTE_CLI} status ${shq(metadata.handle)} --json`),
		) as RunMetadata;
		updateMetadata(metadata.runDir, { state: remoteMeta.state, error: remoteMeta.error, hasStarted: remoteMeta.hasStarted });
	}
	const current = readMetadata(metadata.runDir) ?? metadata;
	if (asJson) {
		process.stdout.write(`${JSON.stringify(current)}\n`);
		return;
	}
	const attach = isRemote(current) ? remoteAttachCommand(current) : `tmux attach -t ${current.tmuxSession}`;
	process.stdout.write(
		`${runDisplayName(current)}: ${effectiveRunState(current)} (${current.provider}/${current.model}, ${current.thinking})${isRemote(current) ? `  @${current.host}` : ""}\nAttach: ${attach}\n`,
	);
}

function renameSubagent(args: string[]): void {
	if (args.length !== 2) usage();
	const metadata = getRun(args[0]);
	const name = normalizeRunName(args[1]);
	if (isRemote(metadata)) {
		runRemote(metadata.host as string, [REMOTE_CLI, "rename", shq(metadata.handle), shq(name)].join(" "));
	}
	const updated = updateMetadata(metadata.runDir, { name });
	if (!updated) fail(`Could not rename subagent: ${metadata.handle}`);
	process.stdout.write(`Renamed ${runDisplayName(updated)}\n`);
}

function sendSubagent(args: string[]): void {
	const handle = args.shift();
	if (!handle) usage();
	let followUp = false;
	const messageParts: string[] = [];
	for (const arg of args) {
		if (arg === "--follow-up") followUp = true;
		else if (arg.startsWith("--")) fail(`Unknown send argument: ${arg}`);
		else messageParts.push(arg);
	}
	const message = messageParts.join(" ").trim();
	if (!message) fail("send requires a message");
	const metadata = getRun(handle);
	if (isRemote(metadata)) {
		const parts = [REMOTE_CLI, "send", shq(metadata.handle)];
		if (followUp) parts.push("--follow-up");
		parts.push(shq(message));
		process.stdout.write(runRemote(metadata.host as string, parts.join(" ")));
		return;
	}
	if (!tmuxSessionExists(metadata.tmuxSession)) fail(`${handle} is not running`);

	const queueDir = inboxDir(metadata.runDir);
	mkdirSync(queueDir, { recursive: true, mode: 0o700 });
	const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
	const target = join(queueDir, `${id}.json`);
	const temporary = `${target}.tmp`;
	const payload: InboxMessage = { message, delivery: followUp ? "followUp" : "auto" };
	writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);

	const state = effectiveRunState(metadata);
	const verb = followUp && state === "busy" ? "Queued follow-up for" : state === "idle" ? "Prompted" : "Steered";
	process.stdout.write(`${verb} ${runDisplayName(metadata)}\n`);
}

function parseTimeout(args: string[]): number {
	if (args.length === 0) return 1800;
	if (args.length !== 2 || args[0] !== "--timeout") usage();
	const timeout = Number(args[1]);
	if (!Number.isInteger(timeout) || timeout <= 0) fail("--timeout must be a positive integer");
	return timeout;
}

async function waitSubagent(args: string[]): Promise<void> {
	const handle = args.shift();
	if (!handle) usage();
	const timeoutSeconds = parseTimeout(args);
	const deadline = Date.now() + timeoutSeconds * 1000;

	const initial = getRun(handle);
	if (isRemote(initial)) {
		const result = spawnSync(
			"ssh",
			[...SSH_OPTIONS, initial.host as string, `${REMOTE_CLI} wait ${shq(handle)} --timeout ${timeoutSeconds}`],
			{ stdio: "inherit" },
		);
		process.exitCode = result.status ?? 1;
		try {
			const remoteMeta = JSON.parse(
				runRemote(initial.host as string, `${REMOTE_CLI} status ${shq(handle)} --json`),
			) as RunMetadata;
			updateMetadata(initial.runDir, { state: remoteMeta.state, error: remoteMeta.error });
		} catch (error) {
			if (/Unknown subagent/.test(String(error))) removeRunDir(initial.runDir);
		}
		return;
	}

	while (Date.now() < deadline) {
		const metadata = getRun(handle);
		const pending = existsSync(inboxDir(metadata.runDir))
			? readdirSync(inboxDir(metadata.runDir)).some((file) => file.endsWith(".json"))
			: false;
		const state = effectiveRunState(metadata);
		if (state === "error") fail(metadata.error || `${handle} failed`);
		if (state === "exited") fail(`${handle} exited before finishing`);
		if (metadata.hasStarted && state === "idle" && !pending) {
			const message = readLatestAssistant(metadata.sessionFile);
			if (!message) fail(`${handle} finished without an assistant response`);
			process.stdout.write(`${handle} finished\n\n${assistantText(message)}\n`);
			if (message.stopReason === "error" || message.stopReason === "aborted") process.exitCode = 1;
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	fail(`Timed out after ${timeoutSeconds}s waiting for ${handle}`);
}

async function stopSubagent(args: string[]): Promise<void> {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	if (isRemote(metadata)) {
		runRemote(metadata.host as string, `${REMOTE_CLI} stop ${shq(metadata.handle)}`);
		removeRunDir(metadata.runDir);
		process.stdout.write(`Stopped ${runDisplayName(metadata)}\n`);
		return;
	}
	const wasRunning = tmuxSessionExists(metadata.tmuxSession);
	spawnSync("tmux", ["kill-session", "-t", metadata.tmuxSession], { stdio: "ignore" });
	if (wasRunning) await waitForRunShutdown(metadata.runDir);
	removeRunDir(metadata.runDir);
	process.stdout.write(`Stopped ${runDisplayName(metadata)}\n`);
}

function fetchSubagent(args: string[]): void {
	const handle = args.shift();
	if (!handle) usage();
	const metadata = getRun(handle);
	if (args.length > 1) usage();
	if (!isRemote(metadata)) {
		fail(`${runDisplayName(metadata)} runs locally; its working directory already is ${metadata.cwd}`);
	}
	const dest = resolve(args[0] ?? join(homedir(), "subagent-results", metadata.name ?? metadata.handle));
	const remoteCwd = metadata.remoteCwd ?? fail(`No remote working directory recorded for ${handle}`);
	mkdirSync(dest, { recursive: true });
	const result = spawnSync("rsync", ["-a", "-e", "ssh", `${metadata.host}:${remoteCwd}/`, `${dest}/`], {
		stdio: "inherit",
	});
	if (result.status !== 0) fail(`rsync from ${metadata.host} failed with exit code ${result.status}`);
	process.stdout.write(`Fetched ${runDisplayName(metadata)} to ${dest}\n`);
}

function listSubagents(args: string[]): void {
	const asJson = args.includes("--json");
	const rest = args.filter((arg) => arg !== "--json");
	if (rest.length !== 0) usage();
	const runs = listRuns(process.env.PI_SESSION_ID || undefined);
	if (asJson) {
		process.stdout.write(`${JSON.stringify(runs)}\n`);
		return;
	}
	if (runs.length === 0) {
		process.stdout.write("No subagents\n");
		return;
	}
	for (const metadata of runs) {
		process.stdout.write(
			`${runDisplayName(metadata)}  ${effectiveRunState(metadata).padEnd(8)}  ${metadata.provider}/${metadata.model}  ${metadata.thinking}${isRemote(metadata) ? `  @${metadata.host}` : ""}\n`,
		);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args.shift();
	switch (command) {
		case "spawn":
			spawnSubagent(args);
			break;
		case "status":
			statusSubagent(args);
			break;
		case "rename":
			renameSubagent(args);
			break;
		case "send":
			sendSubagent(args);
			break;
		case "wait":
			await waitSubagent(args);
			break;
		case "stop":
			await stopSubagent(args);
			break;
		case "fetch":
			fetchSubagent(args);
			break;
		case "list":
			listSubagents(args);
			break;
		default:
			usage();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
