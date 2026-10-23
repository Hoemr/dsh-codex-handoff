---
name: dsh-bridge
description: Hand work to DeepSeek Harness (DSH) and get the result pushed back into this Codex conversation automatically. Use when the user wants DSH to do something ("让 dsh 做…", "派给 dsh", "交给 deepseek harness", "handoff to dsh", "ask dsh"), when the task fits DSH's tools or models, or when the user asks about bridging Codex and DSH. Never open DSH with a browser or computer-use — this bridge is the supported interface.
license: MIT
metadata:
  version: 2.0.0
  author: Hoemr
---

# DSH bridge (Codex ⇄ DeepSeek Harness)

A local, zero-dependency bridge. Codex dispatches work to DSH; when DSH
finishes, its result is pushed back into **this exact Codex thread** as a new
user message.

- Codex → DSH: `dsh-bridge ask` starts a real DSH session (`dsh --profile headless --json`).
- DSH → Codex: on completion, `codex queue --thread "$CODEX_THREAD_ID"` delivers the result.
- Both directions are resumable: DSH `--session session-xxxx`, Codex thread ids.

The command is `dsh-bridge` (installed by the repo's `install.sh`). If it is not on
PATH, run `node <path-to-repo>/bin/bridge.mjs` instead, or set `DSH_BRIDGE_BIN`.

## Dispatch (default: background)

```bash
dsh-bridge ask --background -- "<task>"
```

Returns `status: dispatched` immediately. **Then end your turn.** When DSH
finishes — seconds or minutes later — the result arrives here as a new user
message and you continue. Background is correct for anything that might exceed
a few seconds, because shell calls have timeouts.

Add `--workspace <dir>` when the task belongs to a specific project (defaults to
the current directory). Add `--timeout <sec>` if DSH must be bounded.

## Ask and wait (quick work only)

```bash
dsh-bridge ask -- "<task>"
```

Blocks until DSH finishes and prints its final text. Use only when you need the
answer inside this turn and it should be fast.

## Continue a DSH conversation

```bash
dsh-bridge ask --background --session session-abc123 -- "next step"
```

Reuse the reported session id whenever the work is the same thread of thought —
this keeps DSH's context instead of starting cold.

## Inspect / troubleshoot

```bash
dsh-bridge status        # recent runs: status / DSH session / notify result
dsh-bridge status --json
dsh-bridge doctor        # environment check (dsh, model, credentials, codex)
```

## Sandbox

The bridge must run **outside** Codex's sandbox: DSH writes `~/.dsh`, the bridge
writes `~/.dsh-codex-handoff`. If a command fails with `EPERM`, `EACCES`,
`EROFS`, "read-only", or "沙箱", re-run it once with escalated permissions
(`with_escalated_permissions: true` plus a one-line justification such as
"dsh-codex-handoff needs to write outside the workspace to run DSH"). Do not ask
the user to run it manually.

## Rules

1. Prefer `--background`; after dispatching, do not poll or sleep — end the turn.
2. Never open, screenshot, or click DSH with browser / computer-use tools. If the
   user says "open DSH", dispatch through the bridge instead.
3. Report back: dispatch status, DSH `session_id`, workspace. The user can open
   that session in the DSH sidebar.
4. DSH may also have this project's native plugin installed (`codex_task` /
   `codex_send` / `codex_threads`) that lets DSH call Codex. Do not try to
   configure it; just mention it if relevant.
5. When DSH's result arrives, treat it as the user's next message: continue the
   plan, and re-dispatch only if more DSH work is needed.
6. `MISSING_CREDENTIAL` → run `dsh-bridge doctor`, report the missing key, do not fix
   credentials yourself.

## Example

User: "让 dsh 把这个仓库的测试跑一遍，失败的原因整理出来。"

```bash
dsh-bridge ask --background --workspace "$PWD" -- "跑一遍本仓库测试，整理失败原因，按模块归类"
```

Reply: `已派发（run …，DSH 会话 session-…）。DSH 跑完会自动把结果送回这个对话。`
