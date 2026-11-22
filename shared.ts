import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	realpathSync,
	statSync,
	readSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { acknowledgeInput, inputAcknowledged, isPendingInput, readPendingInput, writePendingInput, type PendingInput } from "./input.ts";

export type RunState = "starting" | "busy" | "idle" | "closing" | "exited" | "error";

/** Default seconds `stop` waits for a closing subagent's final cleanup turn. */
export const DEFAULT_GRACE_SECONDS = 900;

/** Delivered to a subagent when its supervisor stops it: clean up, then report. */
export const CLOSE_MESSAGE =
	"Supervisor close: this subagent is being closed by its supervisor. Stop starting new work. " +
	"Clean up after yourself: kill any background processes you started and remove temporary or scratch files you created that are not part of the deliverable. " +
	"Then write your final report: what you did, what is left unfinished, and anything the supervisor should know.";

export interface HostConfig {
	/** Directory on the remote host under which synced work directories are placed. */
	remoteRoot: string;
	/** Extra rsync exclude patterns for the work-directory sync. */
	syncExcludes?: string[];
	/** Default provider on this host when spawn did not pass --provider explicitly. */
	provider?: string;
	/** Default model on this host when spawn did not pass --model explicitly. */
	model?: string;
	/** Default thinking level on this host when spawn did not pass --thinking explicitly. */
	thinking?: string;
}

export interface SubagentConfig {
	hosts?: Record<string, HostConfig>;
}

export const REMOTE_CLI = "~/.pi/agent/bin/subagent";
export const REMOTE_EXTENSION_DIR = "~/.pi/agent/extensions/subagent";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	/** ssh alias of the host this run executes on; absent for local runs. */
	host?: string;
	/** Working directory on the remote host (mirrors cwd for local runs). */
	remoteCwd?: string;
	/** Local directory that was synced to remoteCwd at spawn time. */
	syncSource?: string;
	tmuxSession: string;
	/**
	 * tmux pane id (`%N`) of the pane pi runs in, recorded by launchRun. Keys meant for pi go
	 * here and not to the session, whose active pane can be another window a human opened.
	 * Absent for runs launched before it was recorded.
	 */
	paneId?: string;
	runDir: string;
	sessionFile: string;
	/** Set at spawn when the transcript is deleted at teardown instead of kept for later reading. */
	discardTranscript?: boolean;
	/**
	 * The transcript path createRun allocated. The child repoints sessionFile to whatever file Pi
	 * reports, so only this path, never repointed, authorises deleting a discarded transcript.
	 */
	allocatedSessionFile?: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Last explicit relaunch acknowledged by the child's session_start hook. */
	resumedLaunch?: string;
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	/** Set when a supervisor close was delivered; the child exits after its final cleanup turn. */
	closing?: boolean;
	/** Set by `stop --force` before it kills the session, so a graceful stop in progress can tell why the child went away. */
	forceStopped?: boolean;
	state: RunState;
	hasStarted: boolean;
	/** Written by the child whenever one agent turn fully settles. */
	settledAt?: string;
	/** Latest settledAt token delivered to this run's dispatching parent session. */
	parentNotifiedSettledAt?: string;
	/** Read-only snapshots from separate child request / parent acknowledgement files. */
	pendingInput?: PendingInput;
	parentNotifiedInputId?: string;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	/** auto: send now (steer if busy). followUp: queue for after the current turn. close: supervisor close, exits the child when the final turn settles. */
	delivery: "auto" | "followUp" | "close";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Host entries from <agentDir>/subagent.json: ssh alias -> remoteRoot and sync excludes. */
export function loadHosts(): Record<string, HostConfig> {
	const path = join(getAgentDir(), "subagent.json");
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null) return {};
		const hosts = (value as Partial<SubagentConfig>).hosts;
		if (typeof hosts !== "object" || hosts === null) return {};
		const result: Record<string, HostConfig> = {};
		for (const [name, config] of Object.entries(hosts)) {
			if (typeof config !== "object" || config === null || typeof config.remoteRoot !== "string") continue;
			result[name] = {
				remoteRoot: config.remoteRoot,
				syncExcludes: config.syncExcludes,
				provider: config.provider,
				model: config.model,
				thinking: config.thinking,
			};
		}
		return result;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

/**
 * A short model name for the one-line status widget: `global.anthropic.claude-opus-5-5` is
 * `opus 5.5`. Display only, from the ID alone: a remote run's provider may not be in this
 * session's model registry. When a rule is unsure, it keeps text rather than drops it.
 */
export function shortModelName(model: string): string {
	let name = model
		.slice(model.lastIndexOf("/") + 1) // router namespace: anthropic/claude-opus-4.5
		// Bedrock region and vendor: global.anthropic. The lookahead needs a model word after
		// them, so deepseek.v3 and llama.cpp keep their first segment.
		.replace(/^(?:[a-z-]+\.)+(?=[a-z]{2}[a-z0-9]*-)/, "")
		// Bedrock model version: -v1:0. Without the colon, -v2 can be a real model version
		// (nemotron-nano-12b-v2), so it is removed only from Claude IDs below.
		.replace(/-v\d+:\d+$/, "")
		.replace(/-\d{8}$/, ""); // release date: -20251101
	if (name.startsWith("claude-")) {
		// Claude IDs always write version digits with hyphens (opus-5-5 is Opus 5.5). Others
		// sometimes do (mistral-medium-3-5), but there a hyphen between digits can also separate
		// fields (qwen3-235b), so only Claude IDs are joined. A date is never a version part.
		name = name
			.slice("claude-".length)
			.replace(/-v\d+$/, "") // anthropic.claude-opus-4-6-v1
			.replace(/(?<=\d)-(?=\d{1,2}(?!\d))/g, ".");
	}
	return name.replaceAll("-", " ") || model;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			typeof metadata.tmuxSession !== "string" ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		const pendingInput = readPendingInput(runDir);
		return {
			...metadata,
			pendingInput: pendingInput?.handle === metadata.handle ? pendingInput : undefined,
			parentNotifiedInputId: pendingInput && inputAcknowledged(runDir, pendingInput.requestId) ? pendingInput.requestId : undefined,
		} as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	// Never persist these snapshots through a metadata read-modify-write. The child alone
	// owns a local request; parent acknowledgements cannot revive a cancelled question.
	const { pendingInput: _input, parentNotifiedInputId: _ack, ...stored } = metadata;
	writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function sessionArchiveDir(): string {
	const dir = resolve(process.env.PI_CODING_AGENT_SESSION_DIR || join(getAgentDir(), "sessions"), "subagents");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (existsSync(getRunsDir()) && inside(realpathSync(getRunsDir()), realpathSync(dir))) {
		throw new Error("Subagent session storage must be outside managed run directories");
	}
	return realpathSync(dir);
}

/**
 * A run's transcript gets a stable private path before Pi starts, outside its control state, so
 * whatever cites it while the run is alive (its spawn output, memory records) still names it after
 * a kept transcript outlives teardown.
 */
export function createSessionFile(handle: string): string {
	const file = join(sessionArchiveDir(), `${handle}-${randomUUID()}.jsonl`);
	writeFileSync(file, "", { flag: "wx", mode: 0o600 });
	return file;
}

type RunSetup = Pick<
	RunMetadata,
	"handle" | "name" | "parentSessionId" | "parentSessionFile" | "cwd" | "provider" | "model" | "thinking" | "launchArgs" | "discardTranscript"
>;

/** Allocate a run's control state and its transcript as one startup transaction. */
export function createRun(setup: RunSetup): RunMetadata {
	mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 });
	const runDir = join(getRunsDir(), setup.handle);
	mkdirSync(runDir, { mode: 0o700 });
	let sessionFile: string | undefined;
	try {
		mkdirSync(inboxDir(runDir), { mode: 0o700 });
		sessionFile = createSessionFile(setup.handle);
		const now = new Date().toISOString();
		const metadata: RunMetadata = {
			...setup, version: 1, runDir, sessionFile, allocatedSessionFile: sessionFile, tmuxSession: `pi-subagent-${setup.handle}`,
			state: "starting", hasStarted: false, createdAt: now, updatedAt: now,
		};
		writeMetadata(metadata);
		return metadata;
	} catch (error) {
		try {
			if (sessionFile && statSync(sessionFile).size === 0) rmSync(sessionFile);
			rmSync(runDir, { recursive: true, force: true });
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], `Subagent startup failed: ${String(error)}; cleanup failed: ${String(cleanupError)}`);
		}
		throw error;
	}
}

function syncPath(path: string): void {
	const fd = openSync(path, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Remove a stopped run's control state. A local run's non-empty transcript is kept, unless the run
 * was spawned to discard it, and the kept path is returned. Remote transcripts are their host's.
 */
export function removeRunDir(runDir: string): string | undefined {
	let control: string;
	try { control = realpathSync(runDir); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const metadata = readMetadata(runDir);
	if (!metadata) {
		if (!existsSync(runDir)) return undefined;
		throw new Error(`Refusing to delete ${runDir}: run metadata is missing or unreadable`);
	}
	let retained: string | undefined;
	if (isRemote(metadata)) {
		// The host owns a remote run's transcript.
	} else if (metadata.discardTranscript === true) {
		// Only the file allocated for this run is deleted, whatever session root is configured now
		// and whichever file the child last reported; unlinking its own path never follows a link
		// to another run's transcript. A file the child switched to stays, and stop reports it.
		if (metadata.allocatedSessionFile) rmSync(metadata.allocatedSessionFile, { force: true });
	} else if (existsSync(metadata.sessionFile)) {
		let file: string;
		let source: ReturnType<typeof statSync>;
		try {
			file = realpathSync(metadata.sessionFile);
			source = statSync(file);
		} catch (error) {
			// A competing teardown may have finished between the existence check and open.
			// Do not delete anything or claim an archive from this already-removed run.
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(runDir)) return undefined;
			throw error;
		}
		if (source.size === 0) {
			// A launch that never wrote a session has no evidence to keep.
			if (inside(realpathSync(sessionArchiveDir()), file)) rmSync(file, { force: true });
		} else {
			retained = file;
			if (inside(control, file)) {
				// Runs spawned before transcripts moved out of the run dir keep theirs here. A link
				// publishes the same bytes without overwriting another archive. Concurrent stops may
				// publish it first; inode identity proves that they retained this file.
				const identity = createHash("sha256").update(`${metadata.createdAt}\0${metadata.childSessionId ?? ""}`).digest("hex");
				retained = join(sessionArchiveDir(), `${basename(runDir)}-${identity}.jsonl`);
				try { linkSync(file, retained); } catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "EEXIST" && code !== "ENOENT") throw error;
					const target = statSync(retained);
					if (target.dev !== source.dev || target.ino !== source.ino) {
						throw new Error(`Refusing to overwrite retained transcript ${retained}`);
					}
				}
			}
			syncPath(retained);
			syncPath(dirname(retained));
		}
	}
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	return retained;
}

export function tmuxSessionExists(session: string): boolean {
	return spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
}

/** Read just Pi's JSONL header. Never let --session silently open a fresh conversation. */
function savedSessionId(path: string): string {
	if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing or non-regular session file: ${path}`);
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(4096);
		const parts: Buffer[] = [];
		// Pi's normal session-header bound is 1 MiB. Don't read a damaged or
		// newline-free multi-GB transcript into memory to check its identity.
		for (;;) {
			if (parts.length * buffer.length >= 1024 * 1024) throw new Error("session header too long");
			const n = readSync(fd, buffer, 0, buffer.length, null);
			const line = buffer.subarray(0, n);
			const end = line.indexOf(10);
			parts.push(Buffer.from(end < 0 ? line : line.subarray(0, end)));
			if (end >= 0 || n === 0) break;
		}
		const header = JSON.parse(Buffer.concat(parts).toString("utf8"));
		if (header?.type !== "session" || typeof header.id !== "string" || !header.id || typeof header.cwd !== "string") throw new Error("invalid header");
		return header.id;
	} catch (error) {
		throw new Error(`No readable Pi session header in ${path}: ${String(error)}`);
	} finally { closeSync(fd); }
}

/** Recover the run on its execution host. A stopped run has no control record to recover. */
export async function resumeRun(run: RunMetadata): Promise<RunMetadata> {
	if (isRemote(run)) throw new Error("Resume must run on the execution host");
	if (run.closing || run.forceStopped || run.state === "closing") throw new Error(`${run.handle} is being stopped`);
	if (tmuxSessionExists(`=${run.tmuxSession}`)) throw new Error(`${run.handle} is already running; attach or send to it`);
	if (!statSync(run.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Missing working directory: ${run.cwd}`);
	const id = savedSessionId(run.sessionFile);
	if (run.childSessionId && run.childSessionId !== id) throw new Error(`Session ID does not match the recorded child: ${run.sessionFile}`);
	const inbox = inboxDir(run.runDir);
	if (existsSync(inbox) && readdirSync(inbox).some(name => name.endsWith(".json"))) {
		throw new Error(`Undelivered messages in ${inbox}; inspect and move them aside before resuming`);
	}
	// tmux owns the unique session name. If two callers race, only the winning
	// child publishes a receipt. A failed launch must not reset the old state.
	const token = randomUUID();
	launchRun(run, [], token);
	const deadline = Date.now() + 15000;
	do {
		const current = readMetadata(run.runDir);
		if (!current || !tmuxSessionExists(`=${run.tmuxSession}`)) throw new Error(`Recovered child ${run.handle} exited before startup was confirmed`);
		if (current.resumedLaunch === token && current.childSessionId === id) return current;
		await new Promise(resolve => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Started tmux for ${run.handle}, but Pi has not confirmed its saved session; attach to inspect it`);
}

/**
 * Start the child pi process for a run in its tmux session and record its pane id in the
 * metadata. `initialArgs` are only passed on first spawn.
 */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = [], resumeToken?: string): void {
	let launcher = "pi";
	// Recovery always opens the recorded conversation in Pi. Don't switch to a
	// launcher that may have appeared in the work tree since the original spawn.
	if (!resumeToken) {
		const testLauncher = join(metadata.cwd, "pi-test.sh");
		try {
			accessSync(testLauncher, constants.X_OK);
			launcher = testLauncher;
		} catch {
			// Use the installed pi executable.
		}
	}

	const result = spawnSync(
		"tmux",
		[
			"new-session",
			"-d",
			"-P",
			"-F",
			"#{pane_id}",
			"-s",
			metadata.tmuxSession,
			"-x",
			"120",
			"-y",
			"40",
			"-c",
			metadata.cwd,
			"--",
			"env",
			`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,
			...(resumeToken ? [`PI_SUBAGENT_RESUMING=${resumeToken}`] : []),
			launcher,
			"--session",
			metadata.sessionFile,
			"--provider",
			metadata.provider,
			"--model",
			metadata.model,
			"--thinking",
			metadata.thinking,
			...(metadata.launchArgs ?? []),
			...initialArgs,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr?.trim() || "Failed to create tmux session");
	// A recovering child publishes its new pane and readiness together. Do not
	// race that acknowledgement with a second metadata read-modify-write here.
	if (resumeToken) return;
	// The child writes its metadata first in session_start, after pi has loaded, so this
	// write lands before it. Relaunches record their new pane the same way; if tmux printed
	// no pane id, the stale one is cleared so interrupt falls back to the first pane.
	const paneId = result.stdout.trim();
	updateMetadata(metadata.runDir, { paneId: /^%\d+$/.test(paneId) ? paneId : undefined });
}

export function isRemote(metadata: RunMetadata): boolean {
	return typeof metadata.host === "string" && metadata.host.length > 0;
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	// Remote runs live in the remote host's tmux server; local tmux knows nothing about them.
	if (
		!isRemote(metadata) &&
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!tmuxSessionExists(metadata.tmuxSession)
	) {
		return "exited";
	}
	return metadata.state;
}

/**
 * A durable child supplies settledAt. previousState is only a compatibility fallback for a
 * child loaded before settledAt existed; observing an already-idle legacy child is not an event.
 */
export function pendingSettlementToken(
	metadata: RunMetadata,
	previousState: RunState | undefined,
	currentState: RunState,
): string | undefined {
	if (!metadata.hasStarted) return undefined;
	const legacySettled =
		!metadata.settledAt && previousState !== undefined && previousState !== "idle" && currentState === "idle";
	const token = metadata.settledAt ?? (legacySettled ? `legacy:${metadata.updatedAt}` : undefined);
	return token && metadata.parentNotifiedSettledAt !== token ? token : undefined;
}

export function activeInput(metadata: RunMetadata, state = effectiveRunState(metadata)): PendingInput | undefined {
	return state === "busy" && !metadata.closing && !metadata.suspended ? metadata.pendingInput : undefined;
}

export function displayRunState(metadata: RunMetadata): string {
	const state = effectiveRunState(metadata);
	return activeInput(metadata, state) ? "waiting-input" : state;
}

/** A remote status/list snapshot, not an owner transfer. Replies are validated on the host. */
export function syncRemoteRun(local: RunMetadata, remote: RunMetadata): void {
	updateMetadata(local.runDir, {
		state: remote.state, error: remote.error, hasStarted: remote.hasStarted, settledAt: remote.settledAt,
		paneId: remote.paneId, childSessionId: remote.childSessionId, sessionFile: remote.sessionFile,
	});
	const input = isPendingInput(remote.pendingInput) && remote.pendingInput.handle === local.handle ? remote.pendingInput : undefined;
	writePendingInput(local.runDir, input);
	if (input && remote.parentNotifiedInputId === input.requestId) acknowledgeInput(local.runDir, input.requestId);
}

export type SettlementDelivery = "trigger" | "display";

/** Retry cancellation and terminal model errors also express "do not immediately restart this run". */
export function parentRunWasInterrupted(aborted: boolean, stopReason: string | undefined): boolean {
	return aborted || stopReason === "aborted" || stopReason === "error";
}

/** A one-shot mode cannot service an unsolicited turn; an abort permits display but not restart. */
export function settlementDelivery(
	parentMode: string,
	parentIdle: boolean,
	parentRunAborted: boolean,
): SettlementDelivery | undefined {
	if (parentMode === "print" || parentMode === "json" || !parentIdle) return undefined;
	return parentRunAborted ? "display" : "trigger";
}

/** Only the Pi session that dispatched a run may consume its automatic parent notification. */
export function isDispatchingSession(metadata: RunMetadata, sessionId = process.env.PI_SESSION_ID): boolean {
	return typeof sessionId === "string" && sessionId.length > 0 && sessionId === metadata.parentSessionId;
}

export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** Quote a value for embedding in a POSIX shell command run over ssh. */
export function shq(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Run a shell command on a remote host (BatchMode). Returns stdout on success. */
export function runRemote(host: string, command: string): string {
	const result = spawnSync("ssh", [...SSH_OPTIONS, host, command], { encoding: "utf8" });
	if (result.status !== 0) {
		const detail = (result.stderr || "").trim() || `ssh exited with ${result.status}`;
		throw new Error(`Remote command on ${host} failed: ${detail}`);
	}
	return result.stdout;
}

export function remoteAttachCommand(metadata: RunMetadata): string {
	return `ssh -t ${metadata.host} tmux attach-session -t ${shq(metadata.tmuxSession)}`;
}

// Attaching to a remote run, and recovering when the host refuses the terminal.
//
// ssh passes the local TERM to the host, and tmux there refuses a client whose TERM has no
// terminfo entry ("missing or unsuitable terminal: xterm-kitty"). The attach then exits at
// once with no usable message. attachWithRecovery finds the cause of a failed attach,
// installs the missing entry in the host user's ~/.terminfo, and attaches again.

/** A terminal type every host is assumed to describe; used when the local one cannot be installed there. */
export const FALLBACK_TERM = "xterm-256color";

/**
 * ssh options for calls whose failure the caller reads as a fact about the host: the attach
 * diagnosis and the state poll. The timeout is longer than SSH_OPTIONS': a ProxyCommand
 * transport (AWS SSM, for example) can need 20 s to open, and a connection that was only
 * slow must not be taken for an unreachable host or a run that is still busy.
 */
const PATIENT_SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30"];

/** The longest such a call may take in all: connect, run the command, read the answer. */
export const REMOTE_CALL_TIMEOUT_MS = 45000;

interface RemoteCall {
	code: number | null;
	stdout: string;
	stderr: string;
	/** Set when the call was ended before its answer was complete: by the time limit, or by the caller. */
	stopped?: "time limit" | "cancelled";
}

/**
 * Run a command on a host and collect its output. Never rejects, and never outlives its time
 * limit or the caller's signal. ConnectTimeout bounds only the connection: a transport that
 * stalls after it, or a host too loaded to answer, would otherwise hold the caller for good.
 * ssh runs in a process group of its own and the whole group is ended, because a ProxyCommand
 * can outlive a signalled ssh. The call does not wait for the output pipes to close either:
 * a process that outlived ssh may still hold them.
 */
function callRemote(
	host: string,
	command: string,
	options: { input?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RemoteCall> {
	return new Promise((resolveCall) => {
		if (options.signal?.aborted) return resolveCall({ code: null, stdout: "", stderr: "", stopped: "cancelled" });
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn("ssh", [...PATIENT_SSH_OPTIONS, host, command], { stdio: ["pipe", "pipe", "pipe"], detached: true });
		} catch (error) {
			// spawn throws at once for arguments it cannot pass, a NUL character for example.
			return resolveCall({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
		}
		let stdout = "";
		let stderr = "";
		let exited: { code: number | null } | undefined;
		let stdoutEnded = false;
		let settled = false;
		const settle = (result: RemoteCall): void => {
			if (settled) return;
			settled = true;
			clearTimeout(limit);
			options.signal?.removeEventListener("abort", cancel);
			child.stdout.destroy();
			child.stderr.destroy();
			resolveCall(result);
		};
		const stop = (stopped: "time limit" | "cancelled"): void => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGTERM");
			} catch {
				// The group is already gone.
			}
			settle({ code: null, stdout, stderr, stopped });
		};
		const cancel = (): void => stop("cancelled");
		const limit = setTimeout(() => stop("time limit"), options.timeoutMs ?? REMOTE_CALL_TIMEOUT_MS);
		limit.unref();
		options.signal?.addEventListener("abort", cancel, { once: true });
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		// ssh alone holds the stdout pipe, so its end and the exit status are the whole answer.
		child.stdout.on("end", () => {
			stdoutEnded = true;
			if (exited) settle({ code: exited.code, stdout, stderr });
		});
		child.on("exit", (code) => {
			exited = { code };
			if (stdoutEnded) settle({ code, stdout, stderr });
		});
		child.on("error", (error) => settle({ code: null, stdout, stderr: error.message }));
		// ssh can exit before it reads stdin; without a listener that EPIPE would crash the caller.
		child.stdin.on("error", () => {});
		child.stdin.end(options.input ?? "");
	});
}

/** The reason a remote call gave no usable answer, for a message to the user. */
function remoteCallFailure(call: RemoteCall, timeoutMs = REMOTE_CALL_TIMEOUT_MS): string {
	if (call.stopped === "cancelled") return "cancelled";
	if (call.stopped === "time limit") return `no answer within ${timeoutMs / 1000} s`;
	return call.stderr.trim().split("\n").pop() || `ssh exit ${call.code}`;
}

/** What one bounded command on a host gave: its output, or why there is none. */
export interface BoundedRemoteResult {
	ok: boolean;
	stdout: string;
	/**
	 * Set when the host's command gave no exit status: the time limit passed, or the ssh
	 * transport itself failed (exit 255). The command may or may not have run.
	 */
	noVerdict?: boolean;
	/** The reason, for a message to the user, when ok is false. */
	failure?: string;
}

/**
 * Run one command on a host inside the remote-call time limit, for a caller that must tell
 * "the host said no" from "no answer came". An answer relay is such a caller: past the limit,
 * or when the connection is lost after the command was sent, the answer may or may not have
 * reached the child, which is uncertain delivery, not rejection. ssh keeps exit status 255 for
 * its own failures and passes any other status on from the host's command.
 */
export async function runRemoteBounded(
	host: string,
	command: string,
	options: { timeoutMs?: number } = {},
): Promise<BoundedRemoteResult> {
	const call = await callRemote(host, command, options);
	if (call.code === 0 && !call.stopped) return { ok: true, stdout: call.stdout };
	return {
		ok: false,
		stdout: call.stdout,
		noVerdict: call.stopped !== undefined || call.code === null || call.code === 255,
		failure: remoteCallFailure(call, options.timeoutMs),
	};
}

/** TERM values that are safe to name in a remote command and in a terminfo path. */
export function isTerminalName(term: string | undefined): term is string {
	return typeof term === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(term);
}

export interface AttachDiagnosis {
	/** Why `tmux attach-session` on the host did not attach. */
	failure: "no-session" | "unknown-terminal" | "unexplained";
	/** The host has `tic`, so a terminfo entry can be compiled there. */
	canInstall: boolean;
}

/** One remote command that prints, as `key=<exit status>` lines, the facts an attach depends on. */
export function attachDiagnosisCommand(tmuxSession: string, term: string): string {
	return [
		`tmux has-session -t ${shq(tmuxSession)} 2>/dev/null; echo "session=$?"`,
		`infocmp ${shq(term)} >/dev/null 2>&1; echo "terminfo=$?"`,
		`command -v tic >/dev/null 2>&1; echo "tic=$?"`,
	].join("; ");
}

/** Read the report that attachDiagnosisCommand printed. */
export function classifyAttachFailure(report: string): AttachDiagnosis {
	const status = (key: string): number | undefined => {
		const match = new RegExp(`^${key}=(\\d+)$`, "m").exec(report);
		return match ? Number(match[1]) : undefined;
	};
	const session = status("session");
	const terminfo = status("terminfo");
	if (session === undefined || terminfo === undefined) return { failure: "unexplained", canInstall: false };
	if (session !== 0) return { failure: "no-session", canInstall: false };
	// Any nonzero status counts as unknown. 1 is a missing entry. 127 is a host without
	// infocmp: the entry cannot be confirmed there, and the fallback TERM is the safe attach.
	if (terminfo !== 0) return { failure: "unknown-terminal", canInstall: status("tic") === 0 };
	return { failure: "unexplained", canInstall: false };
}

/** The effects attachWithRecovery needs. sshAttachTransport is the real one; tests pass a fake. */
export interface AttachTransport {
	/** Attach interactively. `term` overrides the client's TERM on the host. Resolves to the exit status. */
	attach(term?: string): Promise<number | null>;
	/** Run attachDiagnosisCommand on the host. */
	diagnose(term: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
	/** Copy the local terminfo entry for `term` into the host user's ~/.terminfo. */
	installTerminfo(term: string): Promise<boolean>;
}

export interface AttachResult {
	attached: boolean;
	/** What the user must be told: why the attach failed, or what was changed on the host. */
	message?: string;
}

/**
 * Attach to a remote tmux session. When the attach fails, find the cause; when the cause is
 * a terminal type the host does not know, install its description there (or fall back to
 * FALLBACK_TERM when that is not possible) and attach once more. `progress` receives lines
 * for the plain terminal while the recovery runs.
 */
export async function attachWithRecovery(
	transport: AttachTransport,
	target: { where: string; host: string; tmuxSession: string; term: string | undefined },
	progress: (line: string) => void,
): Promise<AttachResult> {
	const { where, host, tmuxSession, term } = target;
	const first = await transport.attach();
	if (first === 0) return { attached: true };

	// A nonzero status is also what a session that was attached and then lost its connection
	// returns, so the wording does not claim that the attach never happened.
	const ended = `Attach to ${where} ended with ssh exit ${first}`;
	if (!isTerminalName(term)) return { attached: false, message: `${ended}. TERM is unset or is not a plain terminal name, so the cause was not checked.` };
	progress(`${ended}; checking why...`);
	const report = await transport.diagnose(term);
	if (report.code !== 0) {
		const detail = report.stderr.trim().split("\n").pop() || `ssh exit ${report.code}`;
		return { attached: false, message: `Could not attach to ${where}: cannot reach ${host} (${detail})` };
	}
	const { failure, canInstall } = classifyAttachFailure(report.stdout);
	if (failure === "no-session") {
		return { attached: false, message: `Could not attach to ${where}: tmux session ${tmuxSession} no longer exists there` };
	}
	if (failure === "unexplained") {
		return { attached: false, message: `${ended}. The tmux session exists and ${host} knows terminal ${term}.` };
	}

	if (canInstall && (await transport.installTerminfo(term))) {
		const installed = `Installed the ${term} terminal description on ${host} (in ~/.terminfo)`;
		progress(`${host} did not know terminal ${term}. ${installed}. Attaching...`);
		const retry = await transport.attach();
		return retry === 0
			? { attached: true, message: `${installed}; ${host} did not know that terminal` }
			: { attached: false, message: `Could not attach to ${where} (ssh exit ${retry}). ${installed}, and the attach still failed.` };
	}
	const unknown = `${host} does not know terminal ${term}, and its description could not be installed there`;
	progress(`${unknown}. Attaching as ${FALLBACK_TERM}...`);
	const retry = await transport.attach(FALLBACK_TERM);
	return retry === 0
		? { attached: true, message: `Attached as ${FALLBACK_TERM}: ${unknown}` }
		: { attached: false, message: `Could not attach to ${where} (ssh exit ${retry}), also as ${FALLBACK_TERM}: ${unknown}` };
}

/** AttachTransport over ssh, for the tmux session of a remote run. */
export function sshAttachTransport(host: string, tmuxSession: string): AttachTransport {
	// Bounded calls: /subagent waits for these with the TUI stopped.
	const capture = async (command: string, input?: string) => {
		const call = await callRemote(host, command, { input });
		return call.stopped ? { code: null, stdout: call.stdout, stderr: remoteCallFailure(call) } : call;
	};
	return {
		attach: (term) =>
			new Promise((resolveExit) => {
				const remote = [...(term ? ["env", `TERM=${term}`] : []), "tmux", "attach-session", "-t", tmuxSession];
				const child = spawn("ssh", ["-t", host, ...remote], { stdio: "inherit" });
				child.on("error", () => resolveExit(null));
				child.on("close", resolveExit);
			}),
		diagnose: (term) => capture(attachDiagnosisCommand(tmuxSession, term)),
		installTerminfo: async (term) => {
			// -x keeps user-defined capabilities (kitty's, for example); tic -x compiles them.
			const entry = spawnSync("infocmp", ["-a", "-x", term], { encoding: "utf8" });
			if (entry.status !== 0 || !entry.stdout) return false;
			return (await capture("mkdir -p ~/.terminfo && tic -x -o ~/.terminfo /dev/stdin", entry.stdout)).code === 0;
		},
	};
}

// Polling remote runs.
//
// A remote run lives in its host's tmux server, so the parent learns its state only by asking
// the host. A poll that fails says nothing about the run: it must not look like "still busy".
// pollRemoteRuns reports every failure. RemoteContact schedules the polls of each host on its
// own, so a slow or dead host does not delay another, and keeps how long each has been
// silent, so the widget can mark a state it could not confirm.

/** How often the parent asks each host for the state of its runs. */
export const REMOTE_POLL_MS = 20000;
/** The states of a host that has not answered for longer than this are shown as unconfirmed. */
export const REMOTE_STALE_MS = 3 * REMOTE_POLL_MS;
/** Failed polls in a row after which the user is told, once, that a host does not answer. */
export const REMOTE_OUTAGE_POLLS = 3;

export type RemotePoll = { ok: true; runs: RunMetadata[] } | { ok: false; error: string };

/**
 * Ask a host for the metadata of all its runs. Never rejects, and never takes longer than the
 * time limit. A signal cancels the poll, for a session that ends while its hosts are asked.
 */
export async function pollRemoteRuns(host: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RemotePoll> {
	const call = await callRemote(host, `${REMOTE_CLI} list --json`, options);
	if (call.stopped || call.code !== 0) return { ok: false, error: remoteCallFailure(call, options.timeoutMs) };
	try {
		const runs: unknown = JSON.parse(call.stdout);
		if (!Array.isArray(runs)) throw new Error("not a list");
		return { ok: true, runs: runs as RunMetadata[] };
	} catch {
		return { ok: false, error: "the answer was not a list of runs" };
	}
}

/**
 * The parent's contact with each remote host: when it was last asked, whether a poll of it is
 * running, since when it has been silent, and how many polls have failed in a row.
 */
export class RemoteContact {
	private readonly startedAt = new Map<string, number>();
	private readonly polling = new Set<string>();
	/** The time from which a host's silence counts: its last answer, or when asking it began. */
	private readonly silentSince = new Map<string, number>();
	private readonly failures = new Map<string, number>();

	/** Whether to ask the host now: no poll of it is running and its period has passed. */
	due(host: string, now: number): boolean {
		if (this.polling.has(host)) return false;
		const last = this.startedAt.get(host);
		// `now < last` is a wall clock that stepped back: it must not postpone the poll.
		return last === undefined || now >= last + REMOTE_POLL_MS || now < last;
	}

	/** A poll of the host starts. The period counts from here, so a slow poll does not stretch it. */
	started(host: string, now: number): void {
		const last = this.startedAt.get(host);
		// Asking begins, or begins again after a break (the host had no runs, the machine
		// slept, the clock stepped back): the silence counts from now, and so do the failures.
		if (last === undefined || now < last || now - last > REMOTE_STALE_MS) {
			this.silentSince.set(host, now);
			this.failures.delete(host);
		}
		this.startedAt.set(host, now);
		this.polling.add(host);
	}

	/** The poll ended with an answer that was recorded. */
	answered(host: string, now: number): void {
		this.polling.delete(host);
		this.silentSince.set(host, now);
		this.failures.delete(host);
	}

	/** The poll ended without one. True once for each outage, when the user should be told about it. */
	failed(host: string): boolean {
		this.polling.delete(host);
		const failures = (this.failures.get(host) ?? 0) + 1;
		this.failures.set(host, failures);
		return failures === REMOTE_OUTAGE_POLLS;
	}

	/** How long the host has been silent, once that is long enough to doubt its states; otherwise undefined. */
	silentFor(host: string, now: number): number | undefined {
		const since = this.silentSince.get(host);
		return since !== undefined && now - since > REMOTE_STALE_MS ? now - since : undefined;
	}
}

/** What the widget adds to a remote run whose host is silent: the age of the state it shows. */
export function remoteSilenceNote(silentForMs: number | undefined): string {
	if (silentForMs === undefined) return "";
	const minutes = Math.floor(silentForMs / 60000);
	return ` (no answer ${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`})`;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
