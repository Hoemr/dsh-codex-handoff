# dsh-codex-handoff

**Bidirectional Codex ⇄ DeepSeek Harness (DSH) collaboration — no computer use, no browser, no manual relaying.**

[中文](README.md) · [Changelog](CHANGELOG.md) · [MIT](LICENSE)

```text
Codex: "hand this to DSH"
        │  dsh-bridge ask --background
        ▼
   A real DSH session runs the task (persisted, resumable, opens in the DSH sidebar)
        │  DSH process exits = done
        ▼
codex queue --thread <original Codex thread>   ← the result returns as a new user message
        │
        ▼
Codex keeps going on its own. Nobody notifies anybody by hand.
```

## What it solves

If you use Codex as the planner and DSH as the executor, you usually hit two walls:

1. **Codex → DSH** requires computer use: open DSH, create a chat, paste the task.
2. **DSH → Codex** has no channel: when DSH finishes, you retype "done" into Codex.

This repo turns both into API calls:

- **Codex → DSH**: `dsh-bridge ask` starts `dsh --profile headless --json`, producing a real, persisted DSH session.
- **DSH → Codex**: on completion the bridge uses Codex's own durable queue (`codex queue --thread $CODEX_THREAD_ID`) so the result lands in the **same Codex thread** as the next user turn.
- **DSH → Codex (reverse dispatch)**: the DSH plugin exposes `codex_task` / `codex_send` / `codex_threads`.

## How it differs from other codex–dsh plugins

> Versions and claims checked on **2026-10-23** against each project's public npm/README. The ecosystem moves fast — PRs correcting this table are welcome.

| Project | Form | Direction | Key difference |
| --- | --- | --- | --- |
| **dsh-codex-handoff (this repo)** | DSH plugin + Codex skill + CLI, one package | **Bidirectional** | The only one that closes the loop back into the *original* Codex conversation, as a queued user turn |
| [`@esroamer/codex-dsh-collab`](https://www.npmjs.com/package/@esroamer/codex-dsh-collab) 0.2.0 | DSH plugin + Codex skill | Codex → DSH only | Its README requires **Windows** and states DSH **does not wake an idle Codex session** |
| [`dsh-codex-workflow`](https://www.npmjs.com/package/dsh-codex-workflow) 1.1.14 | DSH plugin | Codex plans/reviews, DSH executes | The originating Codex task is **never resumed**; results go to its own SQLite bridge |
| [`dsh-session-bridge`](https://www.npmjs.com/package/dsh-session-bridge) 0.7.0 | DSH plugin (agent tools) | Drives sessions inside DSH | No Codex-side entry point; Codex cannot call it |
| [`dsh-acp-door`](https://www.npmjs.com/package/dsh-acp-door) 0.2.0 | DSH plugin | Exposes an ACP endpoint | Solves "drive the running DSH", but the client must speak ACP; Codex is not an ACP client |
| [`dsh-agent-relay`](https://www.npmjs.com/package/dsh-agent-relay) 0.5.0 | Relay + plugin + CLI | Multi-agent message bus | Generic relay; does not wake a specific Codex thread, needs resident clients |
| [`dsh-codex-sync`](https://www.npmjs.com/package/dsh-codex-sync) / [`codex2dsh`](https://www.npmjs.com/package/codex2dsh) / `dsh-bridges` | DSH plugin | Static migration | Migrates skills, MCP config or history; not live collaboration |
| `dsh-llm-codex-app-server` / `dsh-codex-connect(-plus)` | DSH plugin | Model access | Uses Codex models as a DSH provider, not agent-to-agent delegation |

**Positioning in one sentence:** not "Codex drives DSH", not "migrate Codex config into DSH", but **two agents delegating to each other and returning results into the conversation they came from** — native entry points on both sides, resumable in both directions.

## Quick start

Requirements: macOS (primary tested platform), Node ^22.19 or >=24, Codex CLI, DSH Desktop.

```bash
git clone https://github.com/Hoemr/dsh-codex-handoff.git
cd dsh-codex-handoff
./install.sh --with-plugin        # Codex skill + `dsh-bridge` command + DSH plugin
```

Restart DSH (plugins load at startup). Then:

- In **Codex**: "hand this to DSH: <task>" — Codex runs `dsh-bridge ask --background`, ends its turn, and receives DSH's result as a new message.
- In **DSH**: "ask Codex: <question>" — DSH calls `codex_task` and waits for the answer.

Self-check:

```bash
dsh-bridge doctor      # dsh / codex / model config / credentials / notify target
dsh-bridge status      # recent dispatches and notifications
```

Use `--background` for anything longer than a few seconds: the blocking form holds a Codex tool call open and can hit shell timeouts.

## Two shapes

**Codex skill** (`skills/dsh-bridge/SKILL.md`) — triggered in natural language; calls:

```bash
dsh-bridge ask --background [--workspace DIR] [--session session-xxxx] -- "<task>"
dsh-bridge ask -- "<task>"            # short jobs: wait inside the turn
```

**DSH plugin** (`lib/`) — registers three native tools:

| Tool | Purpose |
| --- | --- |
| `codex_task` | Run a task with Codex and return its final answer; pass `thread` to continue an existing Codex thread |
| `codex_send` | Post a message into an existing Codex thread (durable queue, no waiting) |
| `codex_threads` | List recent local Codex threads (id / title / updated_at) |

The plugin is dependency-free: only Node built-ins, no DSH internals.

## How it works

```text
Codex thread T ── dsh-bridge ask --background ──► dsh --profile headless --json [--session-id S]
      ▲                                              │ NDJSON events (session/status/text/final)
      │                                              ▼
      └── codex queue --thread T --message "…"  ◄── process exit = completion
```

- **Completion signal**: the bridge is DSH's parent process; exit == done. No hooks required.
- **Continuation**: DSH `--session session-…`, Codex `thread` / `codex_send`.
- **Model parity**: the bridge derives a headless patch from your desktop/web profile (`agent-default-model` + `llm-pi-ai`) and injects credentials from `~/.dsh/.credentials.yaml` in memory only.

## Commands

```
dsh-bridge ask [--workspace DIR] [--session ID] [--background] [--notify auto|queue|resume|off]
           [--thread ID] [--json] [--raw] [--timeout SEC] [--] <task...>
dsh-bridge codex [--thread ID] [--workspace DIR] [--json] [--] <task...>
dsh-bridge notify --thread ID --message TEXT [--mode queue|resume]
dsh-bridge status [--limit N] [--json]
dsh-bridge doctor
```

Env: `DSH_BIN` `CODEX_BIN` `DSH_HOME` `DSH_BRIDGE_HOME` `DSH_BRIDGE_PROFILE`

## Safety and design notes

1. **Ancestry check**: `CODEX_THREAD_ID` is inherited by child processes. If DSH itself was launched from a Codex terminal, that value is stale; the bridge only trusts it when the nearest agent ancestor is Codex. `--thread` overrides.
2. **Credentials never touch disk**: API keys are read from the DSH credential store into the child env only.
3. **State directory falls back** to `$TMPDIR` when the Codex sandbox forbids `$HOME` writes.
4. **No modifications** to DSH or Codex: only their official CLI entry points (`dsh --profile headless`, `codex exec`, `codex queue`).
5. **Sandbox**: the bridge must run outside Codex's sandbox; the skill re-runs with escalated permissions when it sees `EPERM`/read-only errors.

## Limitations

- Tested on macOS with DSH 0.2.1-rc.2 and Codex CLI 0.163; Linux/Windows path detection exists but is untested.
- Delivery requires the Codex session to be live (desktop/TUI); otherwise the message waits in the durable queue. Use `--notify resume` to force.
- Headless DSH sessions are real but not "running in the GUI" — open them from the DSH sidebar history.
- Not published to npm yet.

## License

[MIT](LICENSE)
