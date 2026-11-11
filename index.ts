import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import {
	attachWithRecovery,
	type AttachResult,
	effectiveRunState,
	inboxDir,
	isRemote,
	launchRun,
	listRuns,
	parentRunWasInterrupted,
	pendingSettlementToken,
	pollRemoteRuns,
	readMetadata,
	RemoteContact,
	remoteSilenceNote,
	removeRunDir,
	runDisplayName,
	settlementDelivery,
	sshAttachTransport,
	type InboxMessage,
	type RunMetadata,
	type RunState,
	tmuxSessionExists,
	updateMetadata,
	waitForRunShutdown,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return (
		typeof message.message === "string" &&
		(message.delivery === "auto" || message.delivery === "followUp" || message.delivery === "close")
	);
}

function displayState(metadata: RunMetadata): string {
	return effectiveRunState(metadata).padEnd(8);
}

function latestAssistantStopReason(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "assistant") return entry.message.stopReason;
	}
	return undefined;
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));
	}

	pi.registerCommand("subagent", {
		description: "Select and attach to a subagent spawned by this session",
		handler: async (_args, ctx) => {
			const runs = listRuns(ctx.sessionManager.getSessionId()).filter((run) => effectiveRunState(run) !== "exited");
			if (runs.length === 0) {
				ctx.ui.notify("No active subagents spawned by this session", "info");
				return;
			}

			const items: SelectItem[] = runs.map((run) => ({
				value: run.handle,
				label: `${runDisplayName(run)}  ${displayState(run)}  ${run.provider}/${run.model}  ${run.thinking}${isRemote(run) ? `  @${run.host}` : ""}`,
			}));
			let tui: TUI | undefined;
			const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
				tui = customTui;
				const list = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);

				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Attach to subagent")), 1, 0));
				container.addChild(list);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`${keyHint("tui.select.confirm", "attach")}  ${keyHint("tui.select.cancel", "cancel")}`,
						),
						1,
						0,
					),
				);
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						list.handleInput(data);
						customTui.requestRender();
					},
				};
			});
			if (!selected || !tui) return;
			const run = runs.find((candidate) => candidate.handle === selected);
			if (!run) return;

			if (isRemote(run)) {
				const host = run.host as string;
				let result: AttachResult | undefined;
				tui.stop();
				try {
					// With the TUI stopped the terminal is the plain screen, so progress goes to stderr.
					result = await attachWithRecovery(
						sshAttachTransport(host, run.tmuxSession),
						{ where: `${run.handle} on ${host}`, host, tmuxSession: run.tmuxSession, term: process.env.TERM },
						(line) => process.stderr.write(`${line}\n`),
					);
				} finally {
					tui.start();
					tui.requestRender(true);
				}
				// Reported once the TUI is back: it redraws over anything printed while it was stopped,
				// which is how a failed attach used to vanish without a word.
				if (result?.message) ctx.ui.notify(result.message, result.attached ? "info" : "error");
				return;
			}

			if (process.env.TMUX) {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["switch-client", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) ctx.ui.notify(`Could not switch to ${run.handle}`, "error");
				return;
			}

			tui.stop();
			try {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["attach-session", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) process.stderr.write(`Could not attach to ${run.handle}\n`);
			} finally {
				tui.start();
				tui.requestRender(true);
			}
		},
	});

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;
		const observedStates = new Map<string, RunState>();
		// Pi makes a new extension instance for every session, so these last for one session.
		const remoteContact = new RemoteContact();
		const remotePolls = new AbortController();
		let parentRunAborted = false;

		const notifySettledRuns = (): void => {
			if (!widgetContext) return;
			for (const run of listRuns(widgetContext.sessionManager.getSessionId())) {
				const state = effectiveRunState(run);
				const previousState = observedStates.get(run.handle);
				const token = pendingSettlementToken(run, previousState, state);
				if (!token) {
					observedStates.set(run.handle, state);
					continue;
				}

				// stop prints the cleanup result synchronously. Do not also wake the parent for
				// that deliberately closing turn, but acknowledge it so reload cannot replay it.
				if (run.closing) {
					updateMetadata(run.runDir, { parentNotifiedSettledAt: token });
					observedStates.set(run.handle, state);
					continue;
				}

				// A queued message can be discarded with the active parent turn. One-shot modes
				// cannot service unsolicited turns; after Escape, show the ping without undoing
				// the user's abort. In every deferred case the durable token remains pending.
				const delivery = settlementDelivery(widgetContext.mode, widgetContext.isIdle(), parentRunAborted);
				if (!delivery) continue;

				const displayName = runDisplayName(run);
				try {
					pi.sendMessage(
						{
							customType: "subagent-state",
							content:
								`Subagent ${displayName} finished a turn and is currently ${state}. ` +
								`Run \`subagent wait ${run.handle}\` now to retrieve its result and continue the delegated work.`,
							display: true,
							details: { handle: run.handle, name: run.name, state, settledAt: run.settledAt },
						},
						{ triggerTurn: delivery === "trigger" },
					);
					updateMetadata(run.runDir, { parentNotifiedSettledAt: token });
					observedStates.set(run.handle, state);
				} catch (error) {
					if (widgetContext.hasUI) {
						widgetContext.ui.notify(
							`Could not deliver completion from ${displayName}: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
				}
			}
		};

		// Remote runs live in the host's tmux server; ask each host for their real states over
		// ssh so the widget and picker stay truthful. Runs stopped on the host side are dropped
		// here. remoteContact schedules each host on its own, once per period counted from this
		// session's polls of it: a slow or dead host does not delay another, and sessions do
		// not all open their connections in the same second. A host that does not answer keeps
		// its last known states, and remoteContact records the silence: the widget marks those
		// states, and a lasting outage is reported once.
		const pollHost = async (host: string, runs: RunMetadata[]): Promise<void> => {
			const poll = await pollRemoteRuns(host, { signal: remotePolls.signal });
			// The session ended while the host was asked.
			if (!widgetContext) return;
			let failure = poll.ok ? undefined : poll.error;
			if (poll.ok) {
				const remoteAll = poll.runs;
				try {
					for (const run of runs) {
						const match = remoteAll.find((candidate) => candidate.handle === run.handle);
						if (match) {
							updateMetadata(run.runDir, {
								state: match.state,
								error: match.error,
								hasStarted: match.hasStarted,
								settledAt: match.settledAt,
							});
						} else {
							removeRunDir(run.runDir);
						}
					}
				} catch (error) {
					// The shadows may hold old states, so the host does not count as answered.
					failure = `its answer could not be recorded (${error instanceof Error ? error.message : String(error)})`;
				}
			}
			if (failure === undefined) {
				remoteContact.answered(host, Date.now());
			} else if (remoteContact.failed(host) && widgetContext.hasUI) {
				widgetContext.ui.notify(
					`Cannot confirm the subagents on ${host}: ${failure}. Their shown states are unconfirmed until the host answers.`,
					"warning",
				);
			}
			refreshWidget();
		};

		const refreshRemoteStates = (): void => {
			if (!widgetContext) return;
			const byHost = new Map<string, RunMetadata[]>();
			for (const run of listRuns(widgetContext.sessionManager.getSessionId()).filter(isRemote)) {
				const host = run.host as string;
				const group = byHost.get(host) ?? [];
				group.push(run);
				byHost.set(host, group);
			}
			const now = Date.now();
			for (const [host, runs] of byHost) {
				if (!remoteContact.due(host, now)) continue;
				remoteContact.started(host, now);
				// pollRemoteRuns never rejects; only a UI call in pollHost can throw.
				void pollHost(host, runs).catch(() => {});
			}
		};

		const refreshWidget = (): void => {
			if (!widgetContext?.hasUI) return;
			const activeRuns = listRuns(widgetContext.sessionManager.getSessionId())
				.map((run) => ({ run, state: effectiveRunState(run) }))
				.filter(({ state }) => state !== "exited");
			if (activeRuns.length === 0) {
				widgetContext.ui.setWidget("subagents", undefined);
				return;
			}

			const visible = activeRuns.slice(0, 5).map(({ run, state }) => {
				const color =
					state === "busy" || state === "closing"
						? "warning"
						: state === "idle"
							? "success"
							: state === "error"
								? "error"
								: "muted";
				// A host that stopped answering: say how old the shown state is, and dim it.
				const silentFor = isRemote(run) ? remoteContact.silentFor(run.host as string, Date.now()) : undefined;
				const suffix = isRemote(run) ? `@${run.host}${remoteSilenceNote(silentFor)}` : "";
				return widgetContext!.ui.theme.fg(silentFor === undefined ? color : "muted", `${run.name ?? run.handle}:${state}${suffix}`);
			});
			if (activeRuns.length > visible.length) {
				visible.push(widgetContext.ui.theme.fg("muted", `+${activeRuns.length - visible.length}`));
			}
			widgetContext.ui.setWidget(
				"subagents",
				[widgetContext.ui.theme.fg("dim", "subagents: ") + visible.join(widgetContext.ui.theme.fg("dim", " | "))],
				{ placement: "belowEditor" },
			);
		};

		pi.on("session_start", (_event, ctx) => {
			// Relaunch children that were suspended when this session was last quit or switched away from.
			// Remote children were never suspended: they keep running on their host across parent restarts.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (isRemote(run)) continue;
				if (!run.suspended || tmuxSessionExists(run.tmuxSession)) continue;
				if (!existsSync(run.sessionFile)) {
					removeRunDir(run.runDir);
					continue;
				}
				const starting = updateMetadata(run.runDir, { state: "starting", error: undefined }) ?? run;
				try {
					launchRun(starting);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					updateMetadata(run.runDir, { state: "error", error: message });
					if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
				}
			}

			// State monitoring is functional behavior, not UI behavior. One-shot print/JSON
			// sessions leave settlements pending; TUI/RPC delivery begins on the first timer tick.
			widgetContext = ctx;
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				observedStates.set(run.handle, effectiveRunState(run));
			}
			refreshWidget();
			refreshRemoteStates();
			widgetTimer = setInterval(() => {
				notifySettledRuns();
				refreshWidget();
				refreshRemoteStates();
			}, 1000);
			widgetTimer.unref();
		});

		pi.on("agent_start", () => {
			parentRunAborted = false;
		});

		pi.on("agent_settled", (event, ctx) => {
			parentRunAborted = parentRunWasInterrupted(event.aborted, latestAssistantStopReason(ctx));
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			// End the polls in flight: a hung ssh would otherwise outlive the session.
			remotePolls.abort();
			observedStates.clear();
			if (ctx.hasUI) ctx.ui.setWidget("subagents", undefined);
			if (event.reason === "reload") return;
			// Suspend running children: stop the process but keep transcript and metadata so resuming this
			// session relaunches them. Children that already exited on their own are discarded.
			// Remote children are left running on their host; their shadow metadata is kept so
			// status/send/wait/attach keep working after the parent resumes.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (isRemote(run)) continue;
				if (!tmuxSessionExists(run.tmuxSession)) {
					if (!run.suspended) removeRunDir(run.runDir);
					continue;
				}
				updateMetadata(run.runDir, { suspended: true });
				spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
				await waitForRunShutdown(run.runDir);
			}
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let closeRequested = false;
	let sessionName: string | undefined;

	const syncSessionName = (): void => {
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		const next = `subagent ${metadata.name ?? metadata.handle}`;
		if (next === sessionName) return;
		pi.setSessionName(next);
		sessionName = next;
	};

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		syncSessionName();
		const queueDir = inboxDir(runDir);
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch (error) {
					unlinkSync(path);
					updateMetadata(runDir, {
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}

				if (payload.delivery === "close") closeRequested = true;
				updateMetadata(runDir, {
					state: "busy",
					error: undefined,
					closing: payload.delivery === "close" ? true : undefined,
				});
				try {
					if (currentContext.isIdle()) {
						pi.sendUserMessage(payload.message);
					} else {
						// A close never interrupts running work: the supervisor gets the
						// current turn plus the cleanup turn, then the child exits.
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "auto" ? "steer" : "followUp",
						});
					}
					unlinkSync(path);
				} catch (error) {
					updateMetadata(runDir, {
						state: currentContext.isIdle() ? "idle" : "busy",
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}
		} finally {
			processing = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: ctx.isIdle() ? "idle" : "busy",
			suspended: undefined,
			error: undefined,
		});
		syncSessionName();
		if (!timer) {
			timer = setInterval(() => void processInbox(), 250);
			timer.unref();
		}
		void processInbox();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined });
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		if (ctx.isIdle()) updateMetadata(runDir, { state: "idle", settledAt: new Date().toISOString() });
		// The supervisor closed this run and its final cleanup turn has settled:
		// the child has nothing left to do. The session file is append-durable, so
		// exiting here ends the tmux session and lets stop's teardown complete.
		if (closeRequested && ctx.isIdle()) {
			updateMetadata(runDir, { state: "exited" });
			process.exit(0);
		}
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (event.reason === "quit") updateMetadata(runDir, { state: "exited" });
	});
}
