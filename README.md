# dsh-codex-handoff

**让 Codex 和 DeepSeek Harness（DSH）双向自由流转：不用 CUA、不用浏览器、不用你人工转达。**

[English](README.en.md) · [更新日志](CHANGELOG.md) · [MIT](LICENSE)

```text
Codex 说：“这块交给 DSH 做”
        │  dsh-bridge ask --background
        ▼
   DSH 会话开始干活（真实、可续聊、能在 DSH 界面里打开）
        │  DSH 进程退出 = 完成
        ▼
codex queue --thread <原 Codex 线程>  ← 结果作为一条新用户消息回到原来的 Codex 对话
        │
        ▼
Codex 自己接着往下干，全程没人通知
```

---

## 目录

- [为什么需要它](#为什么需要它)
- [和其他 codex–dsh 插件的区别](#和其他-codexdsh-插件的区别)
- [快速开始](#快速开始)
- [两种形态](#两种形态)
- [工作原理](#工作原理)
- [配置文件与命令](#配置文件与命令)
- [设计要点与安全边界](#设计要点与安全边界)
- [兼容性与已知限制](#兼容性与已知限制)
- [目录结构](#目录结构)
- [License](#license)

## 为什么需要它

用 Codex 当"大脑"、让 DSH 当"手"的人，通常会卡在同一个地方：

1. Codex 想把活交给 DSH —— 只能靠 CUA/浏览器打开 DSH，新建对话、粘贴任务；
2. DSH 干完了 —— 没有任何机制告诉 Codex，只能由人复述一句"DSH 做完了"。

本仓库把这两步都变成接口调用：

- **Codex → DSH**：`dsh-bridge ask` 启动 `dsh --profile headless --json`，得到一个真实、会落盘、能在 DSH 侧栏打开、可续聊的会话。
- **DSH → Codex**：DSH 结束后，`dsh-bridge` 用 Codex 自己的持久队列（`codex queue --thread $CODEX_THREAD_ID`）把结果**作为一条新的用户消息**投回原 Codex 线程，Codex 自动开下一轮。
- **DSH → Codex（反向派发）**：DSH 侧装了原生插件后，可以直接调 `codex_task` / `codex_send` / `codex_threads` 把活派回 Codex。

## 和其他 codex–dsh 插件的区别

> 版本与描述核对于 **2026-10-23**，以各项目当时公开的 npm / 仓库 README 为准。生态变化很快，欢迎提 PR 修正。

| 项目 | 形态 | 方向 | 与它的关键差异 |
| --- | --- | --- | --- |
| **dsh-codex-handoff（本项目）** | DSH 原生插件 + Codex skill + CLI，同一仓库 | **双向** | 唯一把"DSH 完成后自动回传 Codex 原会话"做成闭环：复用 Codex 持久队列，结果是**对话里的下一轮**，不是新线程、不是轮询 |
| [`@esroamer/codex-dsh-collab`](https://www.npmjs.com/package/@esroamer/codex-dsh-collab) 0.2.0 | DSH 插件 + Codex skill | Codex → DSH 单向 | 其 README 声明需要 **Windows**，并明确写着"**DSH 不会主动唤醒空闲的 Codex 会话**"——回传这一段留给了人 |
| [`dsh-codex-workflow`](https://www.npmjs.com/package/dsh-codex-workflow) 1.1.14 | DSH 插件 | Codex 计划/审查，DSH 执行 | 定位是"Codex 只做只读规划与审查"；设计上**原始 Codex 任务 never resumed**，结果走它自己的 SQLite 桥，不回到你的 Codex 对话 |
| [`dsh-session-bridge`](https://www.npmjs.com/package/dsh-session-bridge) 0.7.0 | DSH 插件（agent 工具） | 在 DSH 内部驱动会话 | 能给 DSH 新建/驱动会话、等回复，但**没有 Codex 侧入口**，Codex 无法调用它 |
| [`dsh-acp-door`](https://www.npmjs.com/package/dsh-acp-door) 0.2.0 | DSH 插件 | 对外暴露 ACP 入口 | 解决"运行中的 DSH 可被外部程序驱动"，但**客户端要自己实现 ACP**；Codex 不是 ACP 客户端 |
| [`dsh-agent-relay`](https://www.npmjs.com/package/dsh-agent-relay) 0.5.0 | 中继 + 插件 + CLI | 多 agent 消息总线 | 通用消息中继，**不负责唤醒某个 Codex 会话**，各端还要常驻客户端 |
| [`dsh-codex-sync`](https://www.npmjs.com/package/dsh-codex-sync) 1.6.2 / [`codex2dsh`](https://www.npmjs.com/package/codex2dsh) 0.1.4 / `dsh-bridges` | DSH 插件 | 静态迁移 | 迁移 skills、MCP、配置或历史会话，**不涉及实时双向协作** |
| `dsh-llm-codex-app-server` / `dsh-codex-connect(-plus)` | DSH 插件 | 模型接入 | 把 Codex/Codex 模型**当成 DSH 的模型提供方**，不是 agent 之间的派活与回传 |

**我们的定位一句话**：不是"让 Codex 指挥 DSH"，也不是"把 Codex 的配置搬进 DSH"，而是**让两个 agent 互相派活、并把结果送回对方原本那轮对话里**——两边都有原生入口，两个方向都能续聊。

具体差异：

1. **回传是"对话级"的，不是"任务级"的。** 结果经 `codex queue` 进入原线程的持久队列（带 revision 触发器），Codex 那一边表现为"用户又发了一条消息"，因此它会自然地继续推理，而不是收到一个孤立的结果文件。
2. **双向都是原生接口。** Codex 侧是 skill（自然语言触发），DSH 侧是 `codex_task` / `codex_send` / `codex_threads` 原生工具（结构化调用、受 DSH 取消信号控制）。
3. **不碰 UI。** 全程进程 + 队列 + stdio，没有截图、点击、坐标，也不依赖浏览器。
4. **一套协议、三种用法。** CLI、Codex skill、DSH 插件共用同一份会话映射（`session-…` ↔ Codex `thread-id`）。
5. **明确的防误伤设计。** 只在"调用链来自 Codex"时才使用继承来的 `CODEX_THREAD_ID`，避免把结果灌进无关会话；凭据只在内存注入，不落盘、不打印。

## 快速开始

环境：macOS（主要验证平台）、Node ^22.19 或 >=24、已安装 Codex CLI 与 DSH Desktop。

```bash
git clone https://github.com/Hoemr/dsh-codex-handoff.git
cd dsh-codex-handoff
./install.sh --with-plugin        # 装 Codex skill + dsh-bridge 命令 + DSH 插件（desktop profile）
```

装完 **重启 DSH**（插件只在启动时加载），然后：

- 在 **Codex** 里说：「这个任务交给 DSH 做：<任务>」——Codex 会 `dsh-bridge ask --background` 派活并结束本轮；DSH 完成后结果自动回到这个对话。
- 在 **DSH** 里说：「问一下 Codex：<问题>」——DSH 会调 `codex_task` 等 Codex 回答。

自检：

```bash
dsh-bridge doctor          # 检查 dsh / codex / 模型配置 / 凭据 / 回告目标
dsh-bridge status          # 最近的派发与回告记录
```

要求 DSH 打开一个超过几秒的任务时，**用 `--background`**：阻塞模式会占住 Codex 的一次工具调用，长任务容易撞上 shell 超时。

## 两种形态

### 1) Codex skill（`skills/dsh-bridge`）

安装后对 Codex 说人话即可触发，它会调用：

```bash
dsh-bridge ask --background [--workspace DIR] [--session session-xxxx] -- "<task>"
dsh-bridge ask -- "<task>"                # 短任务：本轮内等结果
dsh-bridge status / dsh-bridge doctor
```

skill 里已经写清了触发条件、后台/阻塞的选择、续聊方式以及沙箱报错时的处理方式。

### 2) DSH 原生插件（`lib/`）

装进 DSH profile 后注册三个工具：

| 工具 | 作用 |
| --- | --- |
| `codex_task` | 派任务给 Codex 并等它返回最终回答；传 `thread` 可续聊同一 Codex 会话 |
| `codex_send` | 往已有 Codex 会话投递一条消息（默认走持久队列，不等待） |
| `codex_threads` | 列出最近的本机 Codex 会话（id / 标题 / 更新时间） |

插件零依赖，只 import Node 内置模块，不触碰 DSH 内部包。

## 工作原理

```text
┌──────────────┐   dsh-bridge ask --background    ┌───────────────────────────┐
│   Codex 会话  │ ───────────────────────────► │ dsh --profile headless     │
│  (thread T)  │                              │ --json [--session-id S]    │
└──────────────┘                              └─────────────┬─────────────┘
       ▲                                                    │ NDJSON 事件
       │                                                    ▼
       │                                        session / status / text / final
       │                                                    │
       │  codex queue --thread T --message "【DSH 已完成】…"  │ 进程退出 = 完成
       └────────────────────────────────────────────────────┘

DSH 内的反向：codex_task ──► codex exec --json --output-last-message
                        ◄── final answer + thread-id
```

- 完成信号：`dsh-bridge` 是 DSH 的父进程，**进程退出即完成**，不需要 DSH hook。
- 会话续聊：DSH 侧 `--session session-…`；Codex 侧 `thread` / `codex_send`。
- 模型一致：自动从 DSH 的 desktop/web profile 抽 `agent-default-model` + `llm-pi-ai` 生成 patch，headless 会话用的是你在 GUI 里选的同一个模型；凭据从 `~/.dsh/.credentials.yaml` 读入子进程环境。

## 配置文件与命令

```
dsh-bridge ask [--workspace DIR] [--session ID] [--background] [--notify auto|queue|resume|off]
           [--thread ID] [--json] [--raw] [--timeout SEC] [--] <task...>
dsh-bridge codex [--thread ID] [--workspace DIR] [--json] [--] <task...>
dsh-bridge notify --thread ID --message TEXT [--mode queue|resume]
dsh-bridge status [--limit N] [--json]
dsh-bridge doctor
```

| 选项 | 说明 |
| --- | --- |
| `--background` | 立即返回；结果稍后自动回到 Codex 会话。长任务用这个 |
| `--session` | 续用已有 DSH 会话，保持上下文 |
| `--notify` | 回告方式：`auto`（默认，从 Codex 调用时走 queue）、`queue`、`resume`、`off` |
| `--thread` | 回告目标 Codex 线程（默认取 `CODEX_THREAD_ID`，带调用链安全检查） |
| `--json` | 输出一行 JSON 摘要，给 Agent 解析用 |

环境变量：`DSH_BIN` `CODEX_BIN` `DSH_HOME` `DSH_BRIDGE_HOME` `DSH_BRIDGE_PROFILE`

插件配置（profile 的 `cordis.patch.yml`）：

```yaml
- id: codex-bridge
  name: 'dsh-codex-handoff'
  config:
    codexBin: ''                 # 空 = 自动探测 $CODEX_BIN → which codex → ChatGPT.app
    sandbox: workspace-write     # read-only | workspace-write | danger-full-access
    timeoutMs: 900000            # codex_task 默认超时
```

## 设计要点与安全边界

1. **为什么要调用链检查**：`CODEX_THREAD_ID` 会被子进程继承。如果 DSH 恰好是从某个 Codex 终端里启动的，这个变量就是过期值；直接投回去会污染无关会话。桥只认"最近的 agent 祖先是 Codex"的情况，`--thread` 可显式覆盖。
2. **凭据不落地**：`OPENCODE_GO_API_KEY` 等只在生成子进程环境时从 `~/.dsh/.credentials.yaml` 读取，不写日志、不写配置。
3. **状态目录可降级**：Codex 沙箱不允许写 `$HOME` 时自动落到 `$TMPDIR/dsh-codex-handoff`。
4. **不修改 DSH / Codex 本体**：桥只读写它们自己的持久化数据，并调用官方 CLI 入口（`dsh --profile headless`、`codex exec`、`codex queue`）。
5. **沙箱**：桥必须跑在 Codex 沙箱外（DSH 要写 `~/.dsh`）。skill 会在遇到 `EPERM`/read-only 时提示用提升权限重跑；想彻底零点击，可把 Codex 设为 `sandbox_mode = "danger-full-access"`（自行评估风险）。

## 兼容性与已知限制

- **已在 macOS 实测**：DSH 0.2.1-rc.2 + Codex CLI 0.163；Linux/Windows 的路径探测已做兼容处理，但未实测，欢迎反馈。
- **回传需要 Codex 会话处于"活"状态**（桌面端/TUI）。Codex 完全关闭时消息留在持久队列里，下次打开该会话消费；需要立刻推进用 `--notify resume`。
- **headless 会话不是 GUI 里的"正在运行"会话**：它真实存在、可续聊，在 DSH 侧栏历史里打开即可。
- **未发布 npm**：目前通过 `git clone` + `install.sh` 安装。
- 本项目的"回传"依赖 Codex 的 `queue` 子命令；更老的 Codex CLI 没有该子命令时会自动降级到 `exec resume`。

## 目录结构

```
dsh-codex-handoff/
├── lib/index.js                 # DSH 原生插件（codex_task / codex_send / codex_threads）
├── lib/index.d.ts
├── cordis.patch.yml             # 插件挂载配置
├── bin/bridge.mjs               # CLI 与桥的全部逻辑（零依赖）
├── skills/dsh-bridge/SKILL.md   # Codex 技能
├── install.sh                   # 一键安装（skill + 命令 + 可选插件）
├── package.json
├── README.md / README.en.md
├── CHANGELOG.md
└── LICENSE
```

## 开发

```bash
npm run check     # 语法检查
npm run doctor    # 本机环境体检
```

装到自定义 profile：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile <name> add /path/to/dsh-codex-handoff
```

卸载：`dsh plugin --profile <name> remove dsh-codex-handoff`，并删除 `~/.codex/skills/dsh-bridge`、`~/.local/bin/bridge`、`~/.dsh-codex-handoff`。

## License

[MIT](LICENSE)
