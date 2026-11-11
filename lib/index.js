/**
 * dsh-codex-handoff —— 在 DeepSeek Harness 里原生调用本地 Codex CLI。
 *
 * 注册三个 agent 工具：
 *   codex_task     把任务派给 Codex，等它跑完并拿回最终回答（可续用已有 thread）
 *   codex_send     往一个已有的 Codex 会话（thread）里投递消息，不等待
 *   codex_threads  列出最近的本机 Codex 会话，拿到 id / 标题 / 更新时间
 *
 * 与 Codex 侧 skill（~/.codex/skills/dsh-bridge）配合即可双向流转：
 * Codex 用 bridge 把活派给 DSH，DSH 用本插件把活派回 Codex。
 *
 * 零依赖：只用 node 内置模块，不 import 任何 @deepseek-ai 包，
 * 因此插件装到任何 profile 都不会有 peer 解析问题。
 *
 * @module dsh-codex-handoff
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Plugin name registered with the Loader. */
export const name = 'codex-handoff';

/** Host services this plugin consumes. */
export const inject = ['tools'];

/* ------------------------------------------------------------------ utils */

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SANDBOX = 'workspace-write';
const MAX_TEXT_CHARS = 24000;

function whichSync(cmd) {
  const win = process.platform === 'win32';
  const finder = win ? 'where' : 'which';
  // Windows ships an extension-less shell script next to the .cmd shim;
  // the shim is the one Node can launch, so try it first.
  for (const probe of win ? [`${cmd}.cmd`, cmd] : [cmd]) {
    try {
      const r = spawnSync(finder, [probe], { encoding: 'utf8' });
      if (r.status !== 0) continue;
      const p = (r.stdout || '').trim().split(/\r?\n/)[0];
      if (p) return p;
    } catch {
      /* try the next probe */
    }
  }
  return undefined;
}

/**
 * Node cannot spawn a Windows .cmd shim (EINVAL) nor the bare launcher name
 * (ENOENT). npm launchers are shims that run one JS entry with node, so read
 * the shim and launch that entry with this same binary instead.
 */
function launcher(binPath) {
  if (process.platform !== 'win32') return { command: binPath, prefix: [] };
  const shim = /\.(cmd|bat)$/i.test(binPath) ? binPath : `${binPath}.cmd`;
  try {
    if (existsSync(shim)) {
      const text = readFileSync(shim, 'utf8');
      const m = text.match(/%dp0%\\(node_modules\\[^"%\r\n]+\.js)/);
      if (m) {
        const entry = join(dirname(shim), m[1]);
        if (existsSync(entry)) return { command: process.execPath, prefix: [entry] };
      }
    }
  } catch {
    /* fall through to the launcher path */
  }
  return { command: binPath, prefix: [] };
}

function spawnCodex(bin, args, options) {
  const l = launcher(bin);
  return spawn(l.command, [...l.prefix, ...args], options);
}

function spawnCodexSync(bin, args, options) {
  const l = launcher(bin);
  return spawnSync(l.command, [...l.prefix, ...args], options);
}

/** Resolve the Codex CLI: config → $CODEX_BIN → PATH → ChatGPT.app bundle. */
function resolveCodexBin(config) {
  const candidates = [
    config?.codexBin,
    process.env.CODEX_BIN,
    whichSync('codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '' && existsSync(c)) return c.trim();
  }
  return 'codex';
}

/** Child env: drop the Codex session markers DSH may have inherited. */
function codexEnv() {
  const env = { ...process.env };
  for (const key of [
    'CODEX_THREAD_ID',
    'CODEX_SESSION_ID',
    'CODEX_TOOL_CALL_ID',
    'CODEX_SHELL',
    'CODEX_SANDBOX',
    'CODEX_SANDBOX_NETWORK_DISABLED',
  ]) {
    delete env[key];
  }
  return env;
}

function truncate(text, max = MAX_TEXT_CHARS) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（已截断，共 ${s.length} 字符）`;
}

function tail(text, lines = 4) {
  return (text || '').trim().split('\n').slice(-lines).join(' | ');
}

/** Calling session's workspace, so Codex works in the right project. */
function sessionCwd(ctx, exec) {
  try {
    const id = exec?.agent?.session?.id;
    if (typeof id !== 'string' || id === '') return undefined;
    const header = ctx.reflect?.get?.('sessions')?.get?.(id)?.header;
    return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;
  } catch {
    return undefined;
  }
}

function killTree(child, signal) {
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

/**
 * Run `codex exec` for one task and collect its final answer.
 * @returns {Promise<{ok:boolean, threadId:string|null, finalText:string, error:string|null, durationMs:number}>}
 */
function runCodexTask(options) {
  const {
    bin,
    task,
    cwd,
    thread,
    sandbox,
    timeoutMs,
    signal,
  } = options;

  return new Promise((resolve) => {
    const started = Date.now();
    const outFile = join(tmpdir(), `dsh-codex-handoff-${process.pid}-${started}.md`);
    const args = ['exec'];
    if (thread) args.push('resume', thread);
    args.push('--json', '--skip-git-repo-check', '--output-last-message', outFile);
    // `codex exec resume` does not accept -s/--sandbox (only the fresh-exec form does).
    if (sandbox && !thread) args.push('-s', sandbox);
    args.push(task);

    const child = spawnCodex(bin, args, {
      cwd,
      env: codexEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    let stderr = '';
    let threadId = null;
    const messages = [];
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref?.();
    }, Math.max(5000, timeoutMs || DEFAULT_TIMEOUT_MS));

    const onAbort = () => {
      aborted = true;
      killTree(child, 'SIGTERM');
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const handleLine = (line) => {
      const s = line.trim();
      if (!s) return;
      let ev;
      try {
        ev = JSON.parse(s);
      } catch {
        return;
      }
      if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') threadId = ev.thread_id;
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
        messages.push(ev.item.text);
      }
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const finish = (code, spawnError) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (buf.trim()) handleLine(buf);
      let finalText = '';
      try {
        if (existsSync(outFile)) finalText = readFileSync(outFile, 'utf8').trim();
      } catch {
        /* ignore */
      }
      if (!finalText && messages.length > 0) finalText = messages[messages.length - 1];
      let error = null;
      if (spawnError) error = spawnError;
      else if (timedOut) error = `Codex 超时（${Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s）`;
      else if (aborted) error = '已取消';
      else if (code !== 0) error = `codex 退出码 ${code}：${tail(stderr, 3)}`;
      resolve({
        ok: error === null,
        threadId,
        finalText: truncate(finalText),
        error,
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (error) => finish(-1, `无法启动 codex：${error.message}`));
    child.on('close', (code) => finish(code));
  });
}

/** Queue (or resume) one message into an existing Codex thread. */
function sendToCodex(options) {
  const { bin, thread, message, mode } = options;
  if (mode === 'resume') {
    const child = spawnCodex(bin, ['exec', 'resume', thread, message], {
      detached: true,
      stdio: 'ignore',
      env: codexEnv(),
    });
    child.unref();
    return { ok: true, mode, detail: `已在后台 resume Codex 会话（pid ${child.pid}）` };
  }
  const r = spawnCodexSync(bin, ['queue', '--thread', thread, '--message', message], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    env: codexEnv(),
  });
  const ok = r.status === 0;
  return {
    ok,
    mode,
    detail: (ok ? r.stdout : r.stderr || r.error?.message || '').trim(),
  };
}

/** Recent local Codex threads from ~/.codex/session_index.jsonl. */
function listCodexThreads(limit) {
  const home = process.env.CODEX_HOME || join(process.env.HOME || homedir(), '.codex');
  const file = join(home, 'session_index.jsonl');
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (typeof d.id !== 'string') continue;
      rows.push({
        id: d.id,
        title: typeof d.thread_name === 'string' ? d.thread_name : '',
        updated_at: typeof d.updated_at === 'string' ? d.updated_at : '',
      });
    } catch {
      /* skip malformed line */
    }
  }
  rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return rows.slice(0, Math.min(Math.max(limit || 15, 1), 100));
}

/* ----------------------------------------------------------------- config */

const SANDBOX_VALUES = ['read-only', 'workspace-write', 'danger-full-access'];

function normalizeConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  return {
    codexBin: typeof cfg.codexBin === 'string' ? cfg.codexBin.trim() : '',
    sandbox: SANDBOX_VALUES.includes(cfg.sandbox) ? cfg.sandbox : DEFAULT_SANDBOX,
    timeoutMs:
      typeof cfg.timeoutMs === 'number' && cfg.timeoutMs >= 5000 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

/* ------------------------------------------------------------------ tools */

function textRender(fn) {
  return (_args, value) => [{ type: 'text', text: fn(value) }];
}

function buildTools(ctx, cfg) {
  const bin = resolveCodexBin(cfg);

  return [
    {
      name: 'codex_task',
      description:
        '把任务交给本机 Codex CLI 执行，并等待它返回最终回答。适合需要 Codex 的模型/上下文/工具（例如 GPT 系模型、Codex 的浏览器与 computer-use 能力），或者用户明确要求"问一下 Codex"。默认在会话工作目录里运行；传 thread 可继续一个已有 Codex 会话并保留其上下文。返回 thread_id，后续可用 codex_send 继续该会话。注意：这是同步调用，Codex 跑多久就等多久（默认上限 15 分钟），长任务请在 prompt 里说明让 Codex 先给结论。',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: '要交给 Codex 的任务或问题（完整的指令，Codex 看不到本对话上下文）。',
          },
          workspace: {
            type: 'string',
            description: 'Codex 的工作目录绝对路径。缺省用当前 DSH 会话的工作目录。',
          },
          thread: {
            type: 'string',
            description: '要继续的 Codex 会话 id（来自 codex_task 的返回或 codex_threads）。',
          },
          sandbox: {
            type: 'string',
            enum: SANDBOX_VALUES,
            description: 'Codex 的沙箱级别，缺省用插件配置（workspace-write）。',
          },
          timeoutSec: {
            type: 'integer',
            description: '本次调用的超时秒数，缺省 900。',
          },
        },
        required: ['task'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'final_text', 'duration_ms'],
          properties: {
            ok: { type: 'boolean', description: 'Codex 是否正常完成。' },
            thread_id: { type: 'string', description: 'Codex 会话 id（可用于继续对话）。' },
            final_text: { type: 'string', description: 'Codex 的最终回答。' },
            duration_ms: { type: 'integer', description: '耗时（毫秒）。' },
            error: { type: 'string', description: '失败原因（成功时省略）。' },
          },
        },
        render: textRender((v) =>
          v.ok
            ? `Codex 完成（${Math.round(v.duration_ms / 1000)}s，thread ${v.thread_id || '未知'}）：\n${v.final_text}`
            : `Codex 失败：${v.error}`,
        ),
      },
      async execute(args, exec) {
        exec.signal?.throwIfAborted?.();
        const cwd = args.workspace || sessionCwd(ctx, exec) || process.cwd();
        if (!existsSync(cwd)) {
          return {
            ok: false,
            thread_id: '',
            final_text: '',
            duration_ms: 0,
            error: `工作目录不存在：${cwd}`,
          };
        }
        const result = await runCodexTask({
          bin,
          task: args.task,
          cwd,
          thread: args.thread,
          sandbox: args.sandbox || cfg.sandbox,
          timeoutMs: args.timeoutSec ? args.timeoutSec * 1000 : cfg.timeoutMs,
          signal: exec.signal,
        });
        return {
          ok: result.ok,
          thread_id: result.threadId || '',
          final_text: result.ok ? result.finalText : '',
          duration_ms: result.durationMs,
          ...(result.error ? { error: result.error } : {}),
        };
      },
    },

    {
      name: 'codex_send',
      description:
        '往一个已有的 Codex 会话里投递一条消息（用户消息），不等待执行结果。默认走 Codex 的持久队列（codex queue）：Codex 该会话活着时会在当前回合结束后自动接着跑，关着时下次打开会话会消费。mode=resume 则另起一个后台 codex exec resume 进程继续该会话。适合"告诉 Codex 某件事""把 DSH 的结果回告给 Codex"。',
      parameters: {
        type: 'object',
        properties: {
          thread: {
            type: 'string',
            description: '目标 Codex 会话 id。',
          },
          message: {
            type: 'string',
            description: '要投递的消息正文。',
          },
          mode: {
            type: 'string',
            enum: ['queue', 'resume'],
            description: '投递方式，缺省 queue。',
          },
        },
        required: ['thread', 'message'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'mode', 'detail'],
          properties: {
            ok: { type: 'boolean', description: '是否投递成功。' },
            mode: { type: 'string', description: '实际使用的投递方式。' },
            detail: { type: 'string', description: 'Codex 的返回或错误信息。' },
          },
        },
        render: textRender((v) => (v.ok ? `已投递到 Codex（${v.mode}）：${v.detail}` : `投递失败：${v.detail}`)),
      },
      async execute(args, exec) {
        exec.signal?.throwIfAborted?.();
        if (typeof args.thread !== 'string' || args.thread.trim() === '') {
          return { ok: false, mode: 'queue', detail: 'thread 不能为空' };
        }
        const mode = args.mode === 'resume' ? 'resume' : 'queue';
        return sendToCodex({ bin, thread: args.thread.trim(), message: args.message, mode });
      },
    },

    {
      name: 'codex_threads',
      description:
        '列出本机最近的 Codex 会话（id、标题、更新时间），用于挑选一个会话继续或回告。数据来自 ~/.codex/session_index.jsonl。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: '返回条数，缺省 15，最多 100。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['count', 'threads'],
          properties: {
            count: { type: 'integer', description: '返回的会话条数。' },
            threads: {
              type: 'array',
              description: '按更新时间倒序排列的 Codex 会话。',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'title', 'updated_at'],
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  updated_at: { type: 'string' },
                },
              },
            },
          },
        },
        render: textRender(
          (v) =>
            `最近 ${v.count} 个 Codex 会话：\n${v.threads
              .map((t, i) => `${i + 1}. ${t.updated_at.slice(0, 16)}  ${t.id}  ${t.title || '(无标题)'}`)
              .join('\n')}`,
        ),
      },
      async execute(args, exec) {
        exec.signal?.throwIfAborted?.();
        const threads = listCodexThreads(args.limit);
        return { count: threads.length, threads };
      },
    },
  ];
}

/* ---------------------------------------------------------------- plugin */

/**
 * Mount the Codex collaboration tools.
 * @param ctx - host plugin context (this plugin declares `inject = ['tools']`).
 * @param config - see cordis.patch.yml.
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const disposers = [];
  for (const definition of buildTools(ctx, cfg)) {
    disposers.push(ctx.tools.register(definition));
  }
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* already disposed */
        }
      }
    });
  }
}
