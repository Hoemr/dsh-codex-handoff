# dsh-codex-handoff 使用说明（Windows）

安装位置：`C:\Users\yangchao16\AppData\Local\dsh-codex-handoff`（本文件就在此处）。

## 1. 它做什么

两条链路，共用一个状态目录 `~/.codex-dsh-bridge`：

```
Codex  ──dsh-bridge ask──▶  dsh --profile headless --json  ──结果──▶  codex queue --thread <id>   (回到 Codex 会话)
DSH    ──codex_task──────▶  codex exec --json             ──最终回答──▶  DSH 工具返回值
```

- **Codex → DSH**：Codex 侧 skill `~/.codex/skills/dsh-bridge` + CLI `dsh-bridge`。DSH 的进程退出即视为完成，结果用 `codex queue` 推回同一个 Codex 会话。
- **DSH → Codex**：DSH 原生插件（`codex_task` / `codex_send` / `codex_threads`），无 shell、无浏览器。

## 2. 日常用法 A：在 Codex 里把活派给 DSH

直接对 Codex 说就行（skill 会自动触发）：

```
派给 dsh：把这个仓库的测试补齐
让 dsh 在 ~/work/foo 里查一下为什么构建失败
```

Codex 实际执行的命令：

```powershell
dsh-bridge ask --workspace C:\path\to\repo "任务文本"
```

### 命令行参考

| 命令 | 作用 |
| --- | --- |
| `dsh-bridge ask [选项] -- <任务>` | 派给 DSH，阻塞到出结果 |
| `dsh-bridge ask --session <id> <任务>` | 在同一个 DSH 会话里继续（保留上下文） |
| `dsh-bridge codex [--thread <id>] <任务>` | 反向：把任务派给 Codex，当前轮拿回结果 |
| `dsh-bridge notify --thread <id> --message <文本> [--mode queue\|resume]` | 手动往 Codex 会话投递消息 |
| `dsh-bridge status [--limit N] [--json]` | 看历史派发/回告记录 |
| `dsh-bridge doctor` | 体检（先跑这个） |

`ask` 选项：

| 选项 | 说明 |
| --- | --- |
| `--workspace <dir>` | DSH 会话工作目录，默认当前目录 |
| `--timeout <秒>` | 超时终止 DSH |
| `--notify auto\|queue\|resume\|off` | 回告方式，默认 `auto`：能认出 Codex 父进程才回告，否则只落盘 |
| `--thread <id>` | 回告目标 Codex 会话，默认取 `CODEX_THREAD_ID` |
| `--background` | 后台派发立刻返回，完成后结果自己回到 Codex 会话 |
| `--json` / `--raw` | 一行 JSON 摘要 / DSH 事件流 NDJSON |

例子：

```powershell
# 长任务：后台跑，结果自动回到当前 Codex 会话
dsh-bridge ask --background --workspace C:\work\agentnext "跑一遍全量测试并总结失败项"

# 继续上一轮 DSH 会话
dsh-bridge status --limit 5            # 里面能看到 session_id
dsh-bridge ask --session session-abc123 "接着把刚才的用例补完"

# 脚本里用：只要机器可读输出
dsh-bridge ask --json "统计 src 下 TODO 数量" 
```

## 3. 日常用法 B：在 DSH 里把活派给 Codex

三个工具（本会话已加载，直接说"让 Codex 做…"即可）：

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `codex_task` | `task`（必填）、`workspace`、`thread`、`sandbox`（read-only / workspace-write / danger-full-access）、`timeoutSec` | 阻塞等 Codex 跑完，返回最终回答 + `thread_id` |
| `codex_send` | `thread`（必填）、`message`（必填）、`mode`（queue / resume） | 往已有 Codex 会话投递消息，不等结果 |
| `codex_threads` | `limit`（默认 15，上限 100） | 列出本机最近的 Codex 会话，挑 `id` 用 |

典型流程：`codex_task` 拿到 `thread_id` → 后续追问用 `codex_send` 或 `codex_task { thread }`。

## 4. 配置

### 环境变量（CLI 侧）

| 变量 | 作用 |
| --- | --- |
| `DSH_BIN` | dsh 可执行文件，默认从 PATH 找 |
| `CODEX_BIN` | codex 可执行文件，默认从 PATH 找 |
| `DSH_HOME` | DSH 配置根，默认 `~/.dsh` |
| `DSH_BRIDGE_HOME` | 状态目录，默认 `~/.codex-dsh-bridge` |
| `DSH_BRIDGE_PROFILE` | 用哪个 DSH 档生成模型 patch，默认 `web` |

### 插件配置（DSH 侧）

在 `~/.dsh/profiles/web/cordis.patch.yml` 里改 `codex-handoff` 这一行：

```yaml
- insert:
    - id: codex-handoff
      name: dsh-codex-handoff
      config:
        codexBin: ""              # 空 = 从 PATH 找 codex
        sandbox: workspace-write  # read-only | workspace-write | danger-full-access
        timeoutMs: 900000         # 单次 codex_task 的超时
```

改完需要重启 DSH 才生效（插件在启动时挂载）。

### DSH 侧怎么拿到模型和凭据

`dsh-bridge` 从 `DSH_BRIDGE_PROFILE`（默认 `web`）的 `cordis.patch.yml` 里抽出 `agent-default-model` 与 `llm-pi-ai` 两段，生成 `~/.codex-dsh-bridge/model.patch.yml`，再用 `dsh --profile headless --patch <这个文件>` 启动。`apiKeyEnv` 指向的密钥从 `~/.dsh/.credentials.yaml` 读出来，只注入子进程环境，不落盘、不进 patch。所以换了模型/网关只要改 web 档，别处不用动。

## 5. 状态、日志与排障

```powershell
dsh-bridge doctor                 # 11 项体检，全绿才算装好
dsh-bridge status --limit 10      # 每次派发的 run 记录
ls ~/.codex-dsh-bridge\runs       # 每轮一个 .json + 一个 .result.md
ls ~/.codex-dsh-bridge\logs       # DSH 子进程原始输出
```

常见症状：

| 症状 | 原因 / 处理 |
| --- | --- |
| `doctor` 里 dsh/codex 找不到 | PATH 缺 `%APPDATA%\npm`，或设 `DSH_BIN` / `CODEX_BIN` 指绝对路径 |
| `codex_task` 报 `failed to connect to Responses WebSocket` / `Manual prompt was not confirmed` | `~/.codex/config.toml` 的 `model` 是 `chatgpt-web/zero-risk` 这类需要人工粘贴的网关。换成 API 型模型（当前：`gpt-6.1-sol`） |
| 结果没回到 Codex 会话 | 不在 Codex 进程里时 `--notify auto` 自动降级为只落盘；显式给 `--thread <id>`，或改 `--notify queue` |
| DSH 里看不到 `codex_task` | 插件只在 DSH 启动时挂载：重启 DSH 后再看 |
| `ask` 卡住不动 | 加 `--timeout 120` 观察；看 `~/.codex-dsh-bridge/logs` 最后一份输出 |

## 6. Windows 适配（本次改动）

上游只有 macOS 的 `install.sh`，代码在 Windows 上直接不可用，已在本地修好：

1. `.cmd` 不能直接 spawn（ENOENT / EINVAL）→ 读 npm shim 里的 JS 入口，用 `process.execPath` 启动。
2. `which` → `where`，win32 优先 `.cmd`，并去掉 `\r`。
3. 父链探测从 `ps` 换成一次 `powershell Get-CimInstance Win32_Process`（否则永远认不出 `CODEX_THREAD_ID`）。
4. `codex_threads` 的 `process.env.HOME` → `os.homedir()`。
5. 新增 `install.ps1`（本目录内），替代 `install.sh`。

### 重装 / 升级 / 卸载

```powershell
# 重装（幂等：覆盖文件、重写 PATH 启动器、重拷 skill、重新注册插件）
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\dsh-codex-handoff\install.ps1" -Profile web

# 只更新文件、不动插件注册
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\dsh-codex-handoff\install.ps1" -SkipPlugin

# 卸载
dsh plugin --profile web remove dsh-codex-handoff
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\dsh-codex-handoff"
Remove-Item -Force "$env:APPDATA\npm\dsh-bridge.cmd", "$env:APPDATA\npm\dsh-bridge", "$env:APPDATA\npm\dsh-codex-handoff.cmd"
Remove-Item -Recurse -Force "$env:USERPROFILE\.codex\skills\dsh-bridge"
# 可选：Remove-Item -Recurse -Force "$env:USERPROFILE\.codex-dsh-bridge"
```

`dsh plugin remove` 之后要重启 DSH，三个 `codex_*` 工具才会消失。
