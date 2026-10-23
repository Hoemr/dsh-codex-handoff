# Changelog

## 0.1.0 — 2026-10-23

首个公开版本。

- **Codex → DSH**：`dsh-bridge ask`（阻塞 / `--background` / `--session` 续聊 / `--workspace`）。
- **DSH → Codex 回传**：完成后通过 `codex queue --thread $CODEX_THREAD_ID` 把结果投回原 Codex 线程；`queue` 不可用时降级 `codex exec resume`。
- **DSH → Codex 反向派发**：CLI `dsh-bridge codex`，以及 DSH 原生插件 `codex_task` / `codex_send` / `codex_threads`。
- **Codex skill**：`skills/dsh-bridge/SKILL.md`，含后台/阻塞选择、沙箱提权与续聊规则。
- **DSH 插件**：零依赖，`dsh plugin --profile <name> add <repo>` 安装。
- 自动从 desktop/web profile 派生 headless 模型 patch；凭据只在内存注入。
- 调用链检测，避免把结果投递给继承来的陈旧 `CODEX_THREAD_ID`。
- 状态目录在沙箱内自动降级到 `$TMPDIR`。
