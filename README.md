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

### Interrupt

`subagent interrupt <handle>` presses Escape once in the child's tmux pane (`tmux send-keys Escape`), the same as attaching and pressing Escape by hand. The key goes to the pane pi runs in, even if someone opened another window in the child's session. It then waits up to 10 seconds for the child to settle and prints its state. Use it to unblock a stuck child. `send` cannot do this, because a message to a busy child waits behind the running tool call. `stop` cannot do it either: it ends the child, and its graceful close also waits for the current turn.

What Escape does depends on the child's state:

| Child state | Effect of `interrupt` |
|---|---|
| Running a tool (bash, `process wait`) or streaming | Aborts the turn. The transcript records the tool as aborted, or keeps the partial answer with `stopReason: aborted`. The child goes idle. Background processes started with the `process` tool keep running. `wait` then prints the aborted turn and exits 1. |
| Open dialog (e.g. the `question` tool) | Cancels only the dialog. The tool returns "cancelled" and the turn continues, so the child can still be busy when `interrupt` returns. |
| Idle | No effect. Two Escapes within 0.5 s run pi's double-Escape action (the session tree by default). One more Escape closes it. |

**Queued messages are not delivered.** If you `send` (steer or `--follow-up`) to a busy child and then `interrupt` an aborting turn, pi moves every queued message into the child's editor. It does not send them. They stay there until someone presses Enter in the pane. Later `send` calls do not flush them. To get them through, send them again after the interrupt. In the dialog case, Escape does not reach the editor, so queued messages are delivered when the turn continues.

After an interrupt, the child takes `send` as normal.

`interrupt` refuses a child that `stop` is closing. Escape would move the close prompt into the editor, and the child would exit without its cleanup turn. Use `stop --force` instead.

Use `/subagent` to select and attach to an active child. The status widget shows active names (or handles for unnamed runs) and their current state.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the process stops, but transcript and metadata are kept. Resuming that parent session relaunches them idle with their full history. `subagent stop` removes a run permanently.

## Remote hosts

A subagent can run on another machine over ssh. The working directory is rsynced to the host at spawn time, the child runs in the host's tmux, and every management command (status, send, interrupt, wait, stop, rename) is forwarded over ssh. Remote runs appear in `subagent list` and `/subagent` like local ones, marked `@<host>`, and attach through `ssh -t`. Hosts are configured in `~/.pi/agent/subagent.json`:

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

`subagent hosts` lists the configured registry with live reachability and active run counts, so callers can discover usable hosts before spawning. Creating new compute is not this tool's job — discover first, provision only when nothing is usable.

`subagent stop` is a graceful close, not a kill: the child gets one final turn to clean up after itself (kill background processes it started, remove scratch files) and write a closing report, which `stop` prints before the teardown removes tmux, transcript, metadata, and — for remote runs — the synced work directory. Default grace is 900 seconds; `--force` tears down immediately. If a `stop --force` ends the child while a graceful `stop` waits for it, the graceful `stop` says so and prints no report. Children never terminate on a timer: only a supervisor's close ends them.

## License

MIT. This fork is based on [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent) by Mario Zechner, who wrote the original tool; the remote-host execution feature was added here. Original code © Mario Zechner, fork changes © Hugh Cars — see [LICENSE](LICENSE).
