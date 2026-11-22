# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own tmux session with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, queue follow-ups, or attach directly to the child TUI.

When a child turn settles, the extension automatically sends its dispatching parent a `subagent-state` message. An idle parent starts a turn immediately; while the parent is busy, the durable settlement stays unacknowledged until the parent becomes idle, so aborting the active turn cannot discard a queued notification. After an aborted or failed parent turn the ping is displayed without restarting work; the next user turn can act on it. The notification tells the parent to retrieve the durable result with `subagent wait` and continue the delegated work. A `wait` run by the dispatching Pi session acknowledges the result itself and avoids a redundant wake-up; a wait from another shell cannot silence the parent. Delivery is acknowledged in run metadata, so reloads do not replay a notification; remote completions are delivered after the next state refresh. One-shot print and JSON sessions leave notifications pending for a later persistent session. Deliberate `subagent stop` cleanup turns are excluded because `stop` returns their report directly.

## Requirements

- Pi
- Node.js 22.19 or newer
- tmux

## Install

Clone into Pi's global extension directory and expose the CLI on `PATH`:

```sh
git clone git@github.com:earendil-works/pi-subagent.git ~/.pi/agent/extensions/subagent
ln -s ../extensions/subagent/subagent.ts ~/.pi/agent/bin/subagent
```

Run `/reload` in an existing Pi session. The extension contributes its bundled skill automatically.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands.

Override the model configuration when needed:

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files:

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

Restrict tools for a read-only investigation:

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

Manage a run by its generated handle:

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent interrupt a1b2c3
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

`wait` is still useful when the result is required synchronously in the current turn. Do not start a separate polling loop merely to notice completion: the automatic state message wakes the parent after every settled child turn.

### Questions and supervisor input

A child that needs a decision calls its `question` tool, and the session that started it answers with `subagent answer`. This also works when the child has an active goal: the call waits inside the child's turn, so the goal cannot go on past the question until the answer arrives.

**Prerequisite.** This package does not ship a `question` tool and does not install one. The child must load a `question` extension that emits the `question:request:v1` event described below. For a remote child, install that extension on the host yourself: `spawn` copies the subagent package to a host and nothing else, and it never changes another extension there. A `question` tool that does not emit the event opens its own dialog in the child's pane, and the parent hears nothing. A child started with `--no-extensions` has no `question` tool.

With a transport-aware `question` extension loaded in the child, the ordinary `question` tool sends its question and option descriptions to the dispatching parent instead of opening a child modal. The parent receives a `subagent-state` attention message through the same durable delivery path as settlement notifications. Busy parents defer delivery; interrupted parents display it without restarting; print/JSON parents leave it pending. Parent `/reload` preserves active requests and their delivery acknowledgements.

`status`, `list`, and the widget show `waiting-input`. The underlying JSON `state` stays `busy`, with a `pendingInput` snapshot containing the request ID, question, and options. `wait` prints that question promptly and exits with status 2: the question was retrieved, **the task is not complete**. Exit status 0 still means only that the turn settled, so a script that branches on `wait` does not go on past a question. A dispatching parent's `wait` acknowledges only that attention message, never a settlement. Status/list and other sessions' waits do not acknowledge it.

Answer with exactly one response, using the request ID printed by `wait` or the notification:

```sh
subagent answer <handle> <request-id> --option 1
subagent answer <handle> <request-id> --text "Use the existing hook"
subagent answer <handle> <request-id> --cancel
```

Only the dispatching `PI_SESSION_ID` may answer. The CLI waits up to 10 seconds for child acceptance. It rejects stale, malformed, and out-of-range replies; a timeout reports uncertain delivery, so check status before retrying. A run that `stop` has marked as closing takes no answer, including one sent just before the stop. Answering resolves the original tool call through the control inbox while the child is busy. It does not send another model prompt. Answers are labelled **supervisor input, not end-user authorization**. Use `--text` for free text; option numbers refer only to the listed concrete choices. After answering, wait for the task result.

An abort or child reload/shutdown invalidates the request. Graceful `stop` cancels a pending question before queuing the existing cleanup turn, so it does not wait behind that question. Questions during close fail rather than block cleanup. An older question extension without the transport hook still opens its local UI.

The small event protocol is `question:request:v1`: `{ question, options: [{ label, description? }], signal?, claim }`. A handler calls `claim()` synchronously and receives `{ resolve, reject }`; only the first claim succeeds. Resolve with `{ source: "supervisor", kind: "option", option: N }`, `{ source: "supervisor", kind: "text", text }`, or `{ source: "supervisor", kind: "cancel" }`. Reject on transport failure or lifecycle cancellation. An unclaimed request keeps the standalone question UI; a claimed request never falls back to a second UI. `input.ts` owns request persistence, correlation, and resolvers. Local `pending-input.json` is child-owned; immutable `input-acks/<request-id>` files are parent-owned and cannot restore a cancelled request through a metadata write.

Remote status/list relay the same snapshot, and `answer` forwards the correlated command over SSH. Remote state is last-known until refresh (normally within 20 seconds); the host validates every answer, and the host's verdict is the command's result. The relay is bounded by the remote-call time limit. With no verdict from the host (the limit passed, or the connection failed), `answer` reports uncertain delivery, so check status before retrying.

### Interrupt

`subagent interrupt <handle>` presses Escape once in the child's tmux pane (`tmux send-keys Escape`), the same as attaching and pressing Escape by hand. The key goes to the pane pi runs in, even if someone opened another window in the child's session. It then waits up to 10 seconds for the child to settle and prints its state. Use it to unblock a stuck child. `send` cannot do this, because a message to a busy child waits behind the running tool call. `stop` ends the child; its graceful close waits for the current turn except that it cancels a managed pending question first.

What Escape does depends on the child's state:

| Child state | Effect of `interrupt` |
|---|---|
| Running a tool (bash, `process wait`) or streaming | Aborts the turn. The transcript records the tool as aborted, or keeps the partial answer with `stopReason: aborted`. The child goes idle. Background processes started with the `process` tool keep running. `wait` then prints the aborted turn and exits 1. |
| Open local dialog (e.g. an older `question` tool without the transport hook) | Cancels only the dialog. The tool returns "cancelled" and the turn continues, so the child can still be busy when `interrupt` returns. |
| Idle | No effect. Two Escapes within 0.5 s run pi's double-Escape action (the session tree by default). One more Escape closes it. |

**Queued messages are not delivered.** If you `send` (steer or `--follow-up`) to a busy child and then `interrupt` an aborting turn, pi moves every queued message into the child's editor. It does not send them. They stay there until someone presses Enter in the pane. Later `send` calls do not flush them. To get them through, send them again after the interrupt. In the dialog case, Escape does not reach the editor, so queued messages are delivered when the turn continues.

After an interrupt, the child takes `send` as normal.

`interrupt` refuses a child that `stop` is closing. Escape would move the close prompt into the editor, and the child would exit without its cleanup turn. Use `stop --force` instead.

Use `/subagent` to select and attach to an active child. The status widget shows active names (or handles for unnamed runs), a short name for the model and thinking level the run was spawned with, and the current state, for example `build[opus 5.5 xhigh]:busy@box`.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files
- `--discard-transcript`: delete the transcript at `stop` instead of keeping it

Nested subagents are disabled. Child sessions do not receive the subagent skill. A Pi started from inside a child, such as a `pi` run from its bash tool, loads none of this extension and leaves the child's run alone. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the process stops, but transcript and metadata are kept. Resuming that parent session relaunches them idle with their full history. `subagent stop` removes the run's control state permanently.

### Recover a child after a worker reboot

Reconnect to the worker first. A lost SSH connection alone is not a reason to restart a child. If its tmux session is gone, the dispatching Pi session can run:

```sh
subagent resume <handle>
subagent send <handle> "Check which outputs reached disk before continuing."
subagent wait <handle>
```

Resume starts a new tmux pane in the saved workspace with the same handle, Pi transcript and launch settings. It does not sync the workspace, replay the original prompt, or restart an interrupted command. It waits for the control extension to confirm the session ID. The old turn is not a new completion. A lost question is cancelled; if the inbox holds undelivered messages, resume leaves them in place and refuses to start. Inspect them on the host before moving them aside.

The execution host needs a CLI and control extension with this verb. A run already alive should be attached to, not resumed. A stopped run cannot be resumed by handle: its retained transcript is history, not a control record. A failure to contact the host is not proof the launch failed; check status before retrying.

## Transcripts

Each run's transcript has a private, stable path under `<session-root>/subagents/`, where session-root is `PI_CODING_AGENT_SESSION_DIR` or `<agent-dir>/sessions`. Spawn prints it. When a run is torn down, by `stop` or by its parent discarding a child that exited on its own, a non-empty transcript is kept there unless the run was spawned with `--discard-transcript`, which deletes the file spawn allocated; `stop` prints which, and says so if the child had switched to another session file, which is left in place. Empty files from a launch that wrote nothing are removed. A run spawned before transcripts moved out of the run directory has its transcript linked into session storage before that directory is removed, and a failure to do so leaves both the transcript and the control state in place. Kept transcripts are not active runs and `subagent list` does not show them. A remote run's transcript follows the same rule on its execution host; nothing is copied back.

## Remote hosts

A subagent can run on another machine over ssh. The working directory is rsynced to the host at spawn time, the child runs in the host's tmux, and every management command (status, send, answer, interrupt, wait, stop, rename, resume) is forwarded over ssh. Remote runs appear in `subagent list` and `/subagent` like local ones, marked `@<host>`, and attach through `ssh -t`. Hosts are configured in `~/.pi/agent/subagent.json`:

```json
{
  "hosts": {
    "<ssh-alias>": {
      "remoteRoot": "~/subagent-work",
      "provider": "<provider-on-that-host>",
      "model": "<model-on-that-host>",
      "thinking": "high"
    }
  }
}
```

The ssh alias must work non-interactively (BatchMode) and carries the transport — an SSM ProxyCommand entry is fine. The host needs `pi`, `tmux`, `rsync`, and node >= 22.19; the extension copies itself over and links the CLI automatically on first use. Each spawn compares a content hash of the local extension with the one recorded on the host (`~/.pi/agent/subagent-provisioned.sha256`) and copies the extension again when they differ, so a host always runs the spawning CLI's version. Runs already in progress on the host keep running. A host's `provider`/`model`/`thinking` are the spawn defaults when no explicit flags are passed, so `subagent spawn --host <alias> --name work --prompt ...` is all it takes.

`subagent fetch <handle> [dest]` rsyncs results back explicitly — nothing syncs back on its own. On a host with an AWS instance profile, the child's credentials never expire: Bedrock Converse signs via the ambient IMDS chain.

Attaching to a remote run needs the host to know your terminal type. ssh passes the local `TERM`, and tmux refuses a client whose `TERM` has no terminfo entry on the host (`missing or unsuitable terminal: xterm-kitty`), so the attach ends at once. When a `/subagent` attach to a remote run fails, the extension checks the cause on the host and reports it: host unreachable, tmux session gone, or unknown terminal. For an unknown terminal it copies the local entry into the host user's `~/.terminfo` (`infocmp -a -x` here, `tic -x` there; no root needed) and attaches again. If the entry cannot be installed, it attaches with `TERM=xterm-256color`. The `ssh -t <host> tmux attach-session ...` command that `spawn` and `status` print has no such recovery; when the host refuses your terminal, prefix that command with `TERM=xterm-256color`.

The parent learns a remote run's state by asking its host every 20 s, and the "finished a turn" notification follows from that answer. A host that does not answer keeps its last known states. Once it has been silent for a minute the status widget dims its runs and adds the age of what it shows, for example `build[opus 5.5 xhigh]:busy@box (no answer 3m)`, and after three failed polls in a row a warning gives the reason. The state is then unconfirmed: the run may have finished. `subagent status <handle>` asks the host directly. Each host is asked on its own schedule, so a slow or dead host does not delay another. A poll allows 30 s to connect and 45 s in all; at that limit, or when the session ends, its ssh process group is ended.

`subagent hosts` lists the configured registry with live reachability and active run counts, so callers can discover usable hosts before spawning. Creating new compute is not this tool's job — discover first, provision only when nothing is usable.

`subagent stop` is a graceful close, not a kill: the child gets one final turn to clean up after itself (kill background processes it started, remove scratch files) and write a closing report, which `stop` prints before the teardown removes tmux, control metadata, the transcript if the run was spawned with `--discard-transcript`, and — for remote runs — the synced work directory. The work directory is removed only when the child closed after its cleanup turn; otherwise it stays on the host, and a graceful `stop` prints its path. Default grace is 900 seconds; `--force` tears down immediately. If a `stop --force` ends the child while a graceful `stop` waits for it, the graceful `stop` says so and prints no report. Children never terminate on a timer: only a supervisor's close ends them.

## Tests

`npm test` runs the tests that need no Pi install. Tests that load `index.ts` are opt-in: set `PI_TEST_PI_ROOT` to the installed Pi package (see `test/pi-package.mjs`). The question tests also need the separate transport-aware question extension:

```sh
PI_TEST_PI_ROOT=/path/to/pi-coding-agent PI_QUESTION_EXTENSION=/path/to/question.ts npm test
```

They use Pi's own event bus and question UI, a deterministic extension context, and CLI subprocesses. tmux and ssh are faked; no model call or remote host is needed.

## License

MIT. This fork is based on [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent) by Mario Zechner, who wrote the original tool; the remote-host execution feature was added here. Original code © Mario Zechner, fork changes © Hugh Cars — see [LICENSE](LICENSE).
