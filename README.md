# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own tmux session with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, queue follow-ups, or attach directly to the child TUI.

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
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

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

A subagent can run on another machine over ssh. The working directory is rsynced to the host at spawn time, the child runs in the host's tmux, and every management command (status, send, wait, stop, rename) is forwarded over ssh. Remote runs appear in `subagent list` and `/subagent` like local ones, marked `@<host>`, and attach through `ssh -t`. Hosts are configured in `~/.pi/agent/subagent.json`:

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

The ssh alias must work non-interactively (BatchMode) and carries the transport — an SSM ProxyCommand entry is fine. The host needs `pi`, `tmux`, `rsync`, and node >= 22.19; the extension copies itself over and links the CLI automatically on first use. A host's `provider`/`model`/`thinking` are the spawn defaults when no explicit flags are passed, so `subagent spawn --host <alias> --name work --prompt ...` is all it takes.

`subagent fetch <handle> [dest]` rsyncs results back explicitly — nothing syncs back on its own. On a host with an AWS instance profile, the child's credentials never expire: Bedrock Converse signs via the ambient IMDS chain.

`subagent hosts` lists the configured registry with live reachability and active run counts, so callers can discover usable hosts before spawning. Creating new compute is not this tool's job — discover first, provision only when nothing is usable.

`subagent stop` is a graceful close, not a kill: the child gets one final turn to clean up after itself (kill background processes it started, remove scratch files) and write a closing report, which `stop` prints before the teardown removes tmux, transcript, metadata, and — for remote runs — the synced work directory. Default grace is 900 seconds; `--force` tears down immediately. Children never terminate on a timer: only a supervisor's close ends them.

## License

MIT. This fork is based on [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent) by Mario Zechner, who wrote the original tool; the remote-host execution feature was added here. Original code © Mario Zechner, fork changes © Hugh Cars — see [LICENSE](LICENSE).
