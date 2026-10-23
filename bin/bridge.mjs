#!/usr/bin/env node
/**
 * dsh-codex-handoff
 *
 * 让 Codex 与 DeepSeek Harness (DSH) 双向自由流转，无需 CUA / 浏览器 / 人工中转。
 *
 *   Codex → DSH : `bridge ask ...`  →  dsh --profile headless --json（可续聊的持久会话）
 *   DSH → Codex : DSH 跑完后自动 `codex queue --thread $CODEX_THREAD_ID --message ...`，
 *                 结果作为 Codex 对话的下一轮用户消息回到原来的 Codex 会话。
 *
 * 零依赖，只用 Node 内置模块。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HOME = os.homedir();

function pickStateDir() {
  const preferred = process.env.DSH_BRIDGE_HOME || path.join(HOME, '.codex-dsh-bridge');
  const candidates = [preferred, path.join(os.tmpdir(), 'codex-dsh-bridge')];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.writable'), String(process.pid));
      return dir;
    } catch {
      /* try next */
    }
  }
  return preferred;
}

const STATE_DIR = pickStateDir();
const RUNS_DIR = path.join(STATE_DIR, 'runs');
const LOGS_DIR = path.join(STATE_DIR, 'logs');
const PATCH_PATH = path.join(STATE_DIR, 'model.patch.yml');

const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');

/** Locate the dsh launcher across macOS app bundle, PATH, and Windows installs. */
function detectDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  const onPath = which('dsh');
  if (onPath) return onPath;
  const candidates = [
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    path.join(HOME, 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return 'dsh';
}

/** Pick the profile whose model config the headless run should mirror. */
function detectSourceProfile() {
  if (process.env.DSH_BRIDGE_PROFILE) return process.env.DSH_BRIDGE_PROFILE;
  const base = path.join(DSH_HOME, 'profiles');
  const preferred = ['desktop', 'web'];
  for (const name of preferred) {
    if (fs.existsSync(path.join(base, name, 'cordis.patch.yml'))) return name;
  }
  try {
    for (const name of fs.readdirSync(base)) {
      if (fs.existsSync(path.join(base, name, 'cordis.patch.yml'))) return name;
    }
  } catch {
    /* no profiles yet */
  }
  return 'desktop';
}

const SOURCE_PROFILE = detectSourceProfile();
const DSH_BIN = detectDshBin();

function detectCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  try {
    const r = spawnSync('which', ['codex'], { encoding: 'utf8' });
    const p = (r.stdout || '').trim().split('\n')[0];
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* ignore */
  }
  const fallback =
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  return fs.existsSync(fallback) ? fallback : 'codex';
}
const CODEX_BIN = detectCodex();

const MAX_MESSAGE_CHARS = 6000;

/* ------------------------------------------------------------------ utils */

function ensureDirs() {
  try {
    for (const d of [STATE_DIR, RUNS_DIR, LOGS_DIR]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, '.writable'), String(process.pid));
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EROFS')) {
      process.stderr.write(
        `bridge: 无法写入状态目录 ${STATE_DIR}（${e.code}）。\n` +
          '       这通常是 Codex 的沙箱拦截：请用「提升权限 / escalated permissions」重跑同一条命令，\n' +
          '       或让 Codex 会话以非沙箱模式运行。\n',
      );
      process.exit(3);
    }
    throw e;
  }
}

function newRunId() {
  const t = new Date();
  const stamp = t.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

function readRun(runId) {
  const f = path.join(RUNS_DIR, `${runId}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function saveRun(record) {
  ensureDirs();
  record.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(RUNS_DIR, `${record.runId}.json`), JSON.stringify(record, null, 2));
  return record;
}

function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`;
}

function logLine(record, line) {
  try {
    fs.appendFileSync(path.join(LOGS_DIR, `${record.runId}.ndjson`), `${line}\n`);
  } catch {
    /* logging must never break the run */
  }
}

function die(msg, code = 2) {
  process.stderr.write(`bridge: ${msg}\n`);
  process.exit(code);
}

function which(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [cmd], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const first = (r.stdout || '').trim().split('\r?\n')[0];
  return first || null;
}

/** 进程祖先链，用于判断“这次调用是不是 Codex 发起的”。 */
function processAncestry(depth = 12) {
  const chain = [];
  let pid = process.pid;
  for (let i = 0; i < depth; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' });
    if (r.status !== 0) break;
    const line = (r.stdout || '').trim().replace(/^\s+/, '');
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) break;
    chain.push({ ppid: Number(m[1]), comm: m[2] });
    pid = Number(m[1]);
    if (!pid || pid === 1) break;
  }
  return chain;
}

/**
 * 默认回告目标：只在“由 Codex 直接调用”时使用 $CODEX_THREAD_ID。
 * 若进程祖先里出现 DSH 自己（例如 DSH 是从 Codex 终端里带环境变量启动的），
 * 说明该变量是继承来的陈旧值，不能用它往回灌消息。
 */
function detectCodexThread() {
  const env = process.env.CODEX_THREAD_ID;
  if (!env) return null;
  if (process.env.DSH_BRIDGE_TRUST_CODEX_ENV === '1') return env;
  // 从最近往上找：最先遇到的“agent 进程”决定归属。
  // 这样即使 Codex 是从某个 shell 里起的，也不影响判断；而 DSH 内部（包括从 Codex
  // 终端里启动的 DSH）会先遇到 DSH，从而拒绝这个继承来的陈旧线程 id。
  for (const c of processAncestry()) {
    if (/DeepSeek Harness|dsh-desktop-host|dsh\/node_modules/i.test(c.comm)) return null;
    if (/codex|CodexCLI|ChatGPT/i.test(c.comm)) return env;
  }
  return null;
}

/* -------------------------------------------------- model patch + creds */

/**
 * DSH 的 headless 档默认走 deepseek-official；而用户的模型配置在 desktop 档的
 * cordis.patch.yml 里（provider / model / providers 列表）。这里把这两段抽出来
 * 生成一个 patch 覆盖层，让 headless 用与 GUI 完全相同的模型。
 */
function ensureModelPatch({ force = false } = {}) {
  const src = path.join(DSH_HOME, 'profiles', SOURCE_PROFILE, 'cordis.patch.yml');
  const info = { src, patchPath: null, provider: null, model: null, apiKeyEnvs: [] };
  if (!fs.existsSync(src)) return { ...info, reason: `找不到 ${src}` };

  const srcStat = fs.statSync(src);
  const outStat = fs.existsSync(PATCH_PATH) ? fs.statSync(PATCH_PATH) : null;
  if (outStat && !force && outStat.mtimeMs >= srcStat.mtimeMs) {
    const text = fs.readFileSync(PATCH_PATH, 'utf8');
    return Object.assign(info, parsePatchInfo(text), { patchPath: PATCH_PATH });
  }

  const raw = fs.readFileSync(src, 'utf8');
  const parts = raw.split(/^(?=- id: )/m);
  const blocks = [];
  for (const p of parts) {
    const m = p.match(/^- id: (\S+)/);
    if (m && (m[1] === 'agent-default-model' || m[1] === 'llm-pi-ai')) blocks.push(p.trimEnd());
  }
  if (!blocks.length) {
    return { ...info, reason: `${src} 里没有 agent-default-model / llm-pi-ai 配置` };
  }
  const text = `# generated by dsh-codex-handoff from ${src}\n${blocks.join('\n')}\n`;
  ensureDirs();
  fs.writeFileSync(PATCH_PATH, text);
  return Object.assign(info, parsePatchInfo(text), { patchPath: PATCH_PATH });
}

function parsePatchInfo(text) {
  const provider = (text.match(/^\s*provider:\s*(\S+)\s*$/m) || [])[1] || null;
  const model = (text.match(/^\s*model:\s*(\S+)\s*$/m) || [])[1] || null;
  const apiKeyEnvs = [...text.matchAll(/apiKeyEnv:\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  return { provider, model, apiKeyEnvs: [...new Set(apiKeyEnvs)] };
}

/** 从 DSH 凭据库读出 apiKeyEnv 指向的密钥，注入子进程环境（只在内存里，不落盘、不打印）。 */
function resolveCredentialEnvs(names, env) {
  const resolved = {};
  if (!names.length) return resolved;
  const credFile = path.join(DSH_HOME, '.credentials.yaml');
  const text = fs.existsSync(credFile) ? fs.readFileSync(credFile, 'utf8') : '';
  for (const name of names) {
    if (env[name]) {
      resolved[name] = 'env';
      continue;
    }
    const re = new RegExp(`^\\s+${name}:\\s*(.+?)\\s*$`, 'm');
    const m = text.match(re);
    if (m && m[1]) {
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      env[name] = v;
      resolved[name] = 'credentials-store';
    }
  }
  return resolved;
}

function dshEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // 不要继承“当前这个 DSH 会话”的运行标识
  for (const k of [
    'DSH_SESSION_ID',
    'DSH_WEB_URL',
    'DSH_SHELL',
    'DSH_PROFILE',
    'DSH_PROFILE_DIR',
  ]) {
    delete env[k];
  }
  env.DSH_HOME = DSH_HOME;
  return env;
}

/* --------------------------------------------------------------- DS H run */

function runDsh(record, opts, onEvent) {
  const patch = ensureModelPatch();
  const env = dshEnv();
  const creds = resolveCredentialEnvs(patch.apiKeyEnvs, env);

  const args = ['--profile', 'headless'];
  if (patch.patchPath) args.push('--patch', patch.patchPath);
  args.push('--json');
  if (opts.sessionId) args.push('--session-id', opts.sessionId);
  args.push(opts.task);

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(DSH_BIN, args, {
      cwd: opts.workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    let stderr = '';
    let sessionId = null;
    let finalText = '';
    let textChunks = '';
    let error = null;
    let turnEnded = false;
    let timeline = [];
    let timedOut = false;

    let timer = null;
    if (opts.timeoutSec && opts.timeoutSec > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }, opts.timeoutSec * 1000);
    }

    const handleLine = (line) => {
      const s = line.trim();
      if (!s) return;
      let ev;
      try {
        ev = JSON.parse(s);
      } catch {
        return;
      }
      logLine(record, s);
      if (ev.type === 'session' && ev.sessionId) {
        sessionId = ev.sessionId;
        saveRun({ ...record, sessionId, status: 'running', startedAt: new Date().toISOString() });
      } else if (ev.type === 'final' && typeof ev.text === 'string') {
        finalText = ev.text;
      } else if (ev.type === 'text' && typeof ev.text === 'string') {
        textChunks += ev.text;
      } else if (ev.type === 'status' && ev.phase === 'turn_end') {
        turnEnded = true;
        const reason = ev.reason || {};
        if (reason.kind === 'error') {
          error = reason.error?.message || 'DSH turn failed';
        }
      } else if (ev.type === 'tool_call' || ev.type === 'tool' || ev.type === 'step') {
        timeline.push(ev.type);
      }
      if (onEvent) onEvent(ev);
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({
        ok: false,
        code: -1,
        sessionId,
        finalText,
        error: `无法启动 dsh: ${e.message}`,
        stderr,
        durationMs: Date.now() - started,
        patch,
        creds,
      });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (buf.trim()) handleLine(buf);
      if (!finalText && textChunks) finalText = textChunks;
      let err = error;
      const quickFail = Date.now() - started < 2500;
      if (!err && code !== 0 && quickFail && /node\.js v\d|EPERM|EACCES|EROFS|sandbox/i.test(stderr)) {
        err =
          'dsh 在沙箱里启动失败（很可能是 Codex 沙箱拦截了 Electron/DSH 进程）。' +
          '请用「提升权限 / escalated permissions」重跑，或让 Codex 以非沙箱模式运行。原始错误：' +
          stderr.trim().split('\n').slice(-2).join(' | ');
      }
      if (!err && code !== 0) {
        err = timedOut
          ? `DSH 超时（${opts.timeoutSec}s）被终止`
          : `dsh 退出码 ${code}${stderr ? `：${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`;
      }
      if (!err && !turnEnded && code === 0 && !finalText) {
        err = 'DSH 结束但没有返回文本结果';
      }
      resolve({
        ok: !err,
        code,
        sessionId,
        finalText,
        error: err,
        stderr,
        durationMs: Date.now() - started,
        patch,
        creds,
      });
    });
  });
}

/* -------------------------------------------------------------- notify */

function buildNotifyMessage(record, result) {
  const taskLine = (record.task || '').replace(/\s+/g, ' ').slice(0, 160);
  const secs = (result.durationMs / 1000).toFixed(1);
  const head = result.ok
    ? `【DSH 已完成】${taskLine}`
    : `【DSH 执行失败】${taskLine}\n错误：${result.error || '未知错误'}`;
  const body = result.ok
    ? truncate(result.finalText || '（无文本结果）', MAX_MESSAGE_CHARS)
    : '';
  const meta = [
    `DSH 会话：${result.sessionId || '(未知)'}`,
    `工作区：${record.workspace}`,
    `耗时：${secs}s`,
  ].join('  |  ');
  const footer = `（以上由 dsh-codex-handoff 自动回告，不需要用户转达。需要继续同一个 DSH 会话：${SELF} ask --session ${result.sessionId || '<session-id>'} "…"）`;
  return [head, meta, body ? `\n结果：\n${body}` : '', `\n${footer}`].filter(Boolean).join('\n');
}

function queueToCodex(threadId, message) {
  const r = spawnSync(CODEX_BIN, ['queue', '--thread', threadId, '--message', message], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    mode: 'queue',
    ok: r.status === 0,
    detail: (r.status === 0 ? r.stdout : r.stderr || r.error?.message || '').trim(),
  };
}

function resumeCodex(threadId, message, record) {
  const logPath = path.join(LOGS_DIR, `${record.runId}.codex-resume.log`);
  const out = fs.openSync(logPath, 'a');
  const child = spawn(CODEX_BIN, ['exec', 'resume', threadId, message], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: record.workspace,
  });
  child.unref();
  return { mode: 'resume', ok: true, detail: `detached codex exec resume (pid ${child.pid}, log ${logPath})` };
}

function notifyCodex(record, result, mode) {
  const threadId = record.threadId;
  let effective = mode;
  if (effective === 'auto') effective = threadId ? 'queue' : 'off';
  if (effective === 'off' || !threadId) return { mode: 'off', ok: true, detail: 'no notify' };

  const message = buildNotifyMessage(record, result);
  if (effective === 'queue') {
    const r = queueToCodex(threadId, message);
    if (r.ok) return r;
    // queue 失败（例如没有 app-server 在管理该 thread）时降级到 exec resume
    const rr = resumeCodex(threadId, message, record);
    return { ...rr, detail: `queue failed (${r.detail}); fell back to resume: ${rr.detail}` };
  }
  if (effective === 'resume') return resumeCodex(threadId, message, record);
  return { mode: effective, ok: false, detail: `unknown notify mode: ${effective}` };
}

/* -------------------------------------------------------------- commands */

async function executeRun(record, opts, { detached = false } = {}) {
  saveRun({ ...record, status: 'running', startedAt: new Date().toISOString() });
  const result = await runDsh(record, opts, opts.raw ? (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`) : null);

  const finished = saveRun({
    ...record,
    status: result.ok ? 'done' : 'error',
    sessionId: result.sessionId || record.sessionId,
    error: result.error || null,
    durationMs: result.durationMs,
    provider: result.patch?.provider || null,
    model: result.patch?.model || null,
    finishedAt: new Date().toISOString(),
  });

  const resultPath = path.join(RUNS_DIR, `${record.runId}.result.md`);
  fs.writeFileSync(
    resultPath,
    [
      `# DSH run ${record.runId}`,
      `- status: ${result.ok ? 'done' : 'error'}`,
      `- session: ${result.sessionId || ''}`,
      `- workspace: ${record.workspace}`,
      `- task: ${record.task}`,
      `- duration_ms: ${result.durationMs}`,
      `- error: ${result.error || ''}`,
      '',
      '## final',
      result.finalText || '',
      '',
    ].join('\n'),
  );

  const notify = notifyCodex(finished, result, opts.notify);
  saveRun({ ...finished, notify });

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        status: result.ok ? 'ok' : 'error',
        run_id: record.runId,
        session_id: result.sessionId || null,
        workspace: record.workspace,
        duration_ms: result.durationMs,
        notify,
        error: result.error || null,
        result_path: resultPath,
      })}\n`,
    );
  } else if (result.ok) {
    process.stdout.write(`${result.finalText}\n`);
  } else {
    process.stderr.write(`bridge: DSH 失败：${result.error}\n`);
    process.stderr.write(`bridge: 日志 ${path.join(LOGS_DIR, `${record.runId}.ndjson`)}\n`);
  }
  return result.ok ? 0 : 1;
}

async function cmdAsk(opts) {
  ensureDirs();
  const task = opts.task;
  if (!task) die('缺少任务文本：bridge ask "要 DSH 做什么"');
  const workspace = path.resolve(opts.workspace || process.cwd());
  if (!fs.existsSync(workspace)) die(`工作区不存在：${workspace}`);

  const runId = newRunId();
  const record = {
    runId,
    task,
    workspace,
    sessionId: opts.session || null,
    threadId: opts.thread || detectCodexThread(),
    notify: opts.notify || 'auto',
    background: !!opts.background,
    origin: opts.thread || detectCodexThread() ? 'codex' : 'shell',
    status: 'queued',
    createdAt: new Date().toISOString(),
  };
  saveRun(record);

  if (opts.background) {
    const child = spawn(process.execPath, [SELF, '_run', '--run', runId], {
      detached: true,
      stdio: 'ignore',
      cwd: workspace,
      env: process.env,
    });
    child.unref();
    saveRun({ ...record, status: 'dispatched', pid: child.pid });
    const payload = {
      status: 'dispatched',
      run_id: runId,
      session_id: null,
      workspace,
      notify: record.threadId ? 'queue' : 'off',
      codex_thread: record.threadId,
      message: record.threadId
        ? '已后台派发给 DSH；完成后结果会自动以新消息回到这个 Codex 会话，先结束本轮即可。'
        : '已后台派发给 DSH；没有检测到 CODEX_THREAD_ID，结果只会写入 ~/.codex-dsh-bridge。',
    };
    process.stdout.write(`${opts.json ? JSON.stringify(payload) : payload.message}\n`);
    return 0;
  }
  return executeRun(record, opts);
}

async function cmdRun(opts) {
  const record = readRun(opts.run);
  if (!record) die(`找不到 run：${opts.run}`);
  const started = Date.now();
  await executeRun(record, { ...opts, task: record.task, workspace: record.workspace, sessionId: record.sessionId, notify: record.notify, raw: false }, { detached: true });
  process.stderr.write(`bridge: run ${record.runId} 完成（${Date.now() - started}ms）\n`);
  return 0;
}


/* 反向：DSH（或任意 shell）把任务派给 Codex，并在同一轮里拿回结果。 */
function cmdCodex(opts) {
  ensureDirs();
  if (!opts.task) die('缺少任务文本：bridge codex "要让 Codex 做什么"');
  const workspace = path.resolve(opts.workspace || process.cwd());
  const outFile = path.join(STATE_DIR, `codex-last-${Date.now()}.md`);
  const args = ['exec'];
  if (opts.thread) args.push('resume', opts.thread);
  args.push('--json', '--skip-git-repo-check', '--output-last-message', outFile, opts.task);

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(CODEX_BIN, args, {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let buf = '';
    let stderr = '';
    let threadId = null;
    const messages = [];
    const handle = (line) => {
      const t = line.trim();
      if (!t) return;
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {
        return;
      }
      if (ev.type === 'thread.started' && ev.thread_id) threadId = ev.thread_id;
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
        messages.push(ev.item.text);
      }
    };
    child.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('close', (code) => {
      if (buf.trim()) handle(buf);
      let finalText = '';
      try {
        if (fs.existsSync(outFile)) finalText = fs.readFileSync(outFile, 'utf8').trim();
      } catch {
        /* ignore */
      }
      if (!finalText) finalText = messages.length ? messages[messages.length - 1] : '';
      const ok = code === 0;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ status: ok ? 'ok' : 'error', codex_thread_id: threadId, duration_ms: Date.now() - started, error: ok ? null : stderr.trim().split('\n').slice(-3).join(' | ') || `exit ${code}` })}\n`,
        );
      } else if (ok) {
        process.stdout.write(`${finalText}\n`);
      } else {
        process.stderr.write(`bridge: codex 失败（退出码 ${code}）：${stderr.trim().split('\n').slice(-3).join(' | ')}\n`);
      }
      resolve(ok ? 0 : 1);
    });
    child.on('error', (e) => {
      process.stderr.write(`bridge: 无法启动 codex: ${e.message}\n`);
      resolve(1);
    });
  });
}

function cmdNotify(opts) {
  if (!opts.thread) die('缺少 --thread');
  if (!opts.message) die('缺少 --message');
  let r;
  if (opts.mode === 'resume') {
    r = resumeCodex(opts.thread, opts.message, { runId: `manual-${Date.now()}`, workspace: process.cwd() });
  } else {
    r = queueToCodex(opts.thread, opts.message);
  }
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  return r.ok ? 0 : 1;
}

function cmdStatus(opts) {
  ensureDirs();
  const files = fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, opts.limit || 20);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(files, null, 2)}\n`);
    return 0;
  }
  if (!files.length) {
    process.stdout.write('还没有运行记录。\n');
    return 0;
  }
  for (const r of files) {
    const notify = r.notify ? `${r.notify.mode}:${r.notify.ok ? 'ok' : 'fail'}` : '-';
    process.stdout.write(
      `${r.runId}  ${String(r.status).padEnd(10)}  ${String(r.sessionId || '-').padEnd(40)}  ${notify}  ${r.workspace}\n`,
    );
  }
  return 0;
}

function cmdDoctor() {
  ensureDirs();
  const rows = [];
  const add = (name, ok, detail) => rows.push({ name, ok, detail });

  add('Node', true, process.version);
  add('dsh 可执行文件', fs.existsSync(DSH_BIN), DSH_BIN);
  if (fs.existsSync(DSH_BIN)) {
    const v = spawnSync(DSH_BIN, ['-V'], { encoding: 'utf8', timeout: 60000 });
    add('dsh 版本', v.status === 0, (v.stdout || v.stderr || '').trim().split('\n')[0] || 'unknown');
  }
  const patch = ensureModelPatch();
  add('模型 patch', !!patch.patchPath, patch.patchPath || patch.reason || '未生成');
  add('模型', !!patch.provider, `${patch.provider || '?'} / ${patch.model || '?'}（来源：${SOURCE_PROFILE} 档）`);
  const envCopy = { ...process.env };
  const creds = resolveCredentialEnvs(patch.apiKeyEnvs, envCopy);
  for (const name of patch.apiKeyEnvs) {
    add(`凭据 ${name}`, !!creds[name], creds[name] || '未在环境或 ~/.dsh/.credentials.yaml 中找到');
  }
  add('codex 可执行文件', fs.existsSync(CODEX_BIN) || !!which(CODEX_BIN), CODEX_BIN);
  const cv = spawnSync(CODEX_BIN, ['--version'], { encoding: 'utf8', timeout: 30000 });
  add('codex 版本', cv.status === 0, (cv.stdout || cv.stderr || '').trim().split('\n')[0]);
  const qh = spawnSync(CODEX_BIN, ['queue', '--help'], { encoding: 'utf8', timeout: 30000 });
  add('codex queue 可用', qh.status === 0, qh.status === 0 ? 'ok' : '不可用（请升级 Codex CLI）');
  const detectedThread = detectCodexThread();
  add(
    '自动回告目标',
    true,
    detectedThread
      ? `CODEX_THREAD_ID=${detectedThread}`
      : process.env.CODEX_THREAD_ID
        ? `检测到 $CODEX_THREAD_ID=${process.env.CODEX_THREAD_ID}，但调用链来自 DSH/普通 shell，默认不使用（可用 --thread 强制指定）`
        : '当前调用链不在 Codex 内（属正常；从 Codex 里调用时自动可用）',
  );
  add('状态目录', true, STATE_DIR);

  for (const r of rows) process.stdout.write(`${r.ok ? '✅' : '❌'} ${r.name}: ${r.detail}\n`);
  const failed = rows.filter((r) => !r.ok).length;
  process.stdout.write(failed ? `\n有 ${failed} 项需要处理。\n` : '\n全部就绪。\n');
  return failed ? 1 : 0;
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split('=');
    const val = inline !== undefined ? inline : argv[i + 1];
    const take = () => (inline !== undefined ? inline : argv[++i]);
    switch (k) {
      case 'workspace':
        opts.workspace = take();
        break;
      case 'session':
      case 'session-id':
        opts.session = take();
        break;
      case 'thread':
        opts.thread = take();
        break;
      case 'notify':
        opts.notify = take();
        break;
      case 'mode':
        opts.mode = take();
        break;
      case 'message':
        opts.message = take();
        break;
      case 'run':
        opts.run = take();
        break;
      case 'limit':
        opts.limit = Number(take());
        break;
      case 'timeout':
        opts.timeoutSec = Number(take());
        break;
      case 'background':
      case 'bg':
        opts.background = true;
        break;
      case 'json':
        opts.json = true;
        break;
      case 'raw':
        opts.raw = true;
        break;
      case 'verbose':
        opts.verbose = true;
        break;
      case 'help':
      case 'h':
        opts.help = true;
        break;
      default:
        void val;
        die(`未知选项 --${k}`);
    }
  }
  return opts;
}

const HELP = `dsh-codex-handoff — Codex ⇄ DeepSeek Harness 双向流转

用法:
  bridge ask [选项] [--] <task...>     把任务派给 DSH
  bridge ask --session <id> <task...>  在同一个 DSH 会话里继续
  bridge codex [--thread <id>] [--json] [--] <task...>  反向：把任务派给 Codex
  bridge notify --thread <id> --message <text> [--mode queue|resume]
  bridge status [--limit N] [--json]   查看派发/回告记录
  bridge doctor                        体检

ask 选项:
  --workspace <dir>   DSH 会话的工作目录（默认：当前目录）
  --session <id>      续用已有 DSH 会话（session-xxxx）
  --background        后台派发后立即返回；DSH 完成后结果自动回到当前 Codex 会话
  --notify <mode>     auto|queue|resume|off（默认 auto）
  --thread <id>       回告目标 Codex 会话（默认取环境变量 CODEX_THREAD_ID）
  --json              输出一行 JSON 摘要
  --raw               把 DSH 事件流以 NDJSON 打到 stdout
  --timeout <sec>     超时终止 DSH

环境变量:
  DSH_BIN, CODEX_BIN, DSH_HOME, DSH_BRIDGE_HOME, DSH_BRIDGE_PROFILE
`;

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const cmd = opts._.shift();
  if (opts.help || !cmd || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  opts.task = opts._.join(' ') || undefined;

  switch (cmd) {
    case 'ask':
      return cmdAsk(opts);
    case '_run':
      return cmdRun(opts);
    case 'codex':
      return cmdCodex(opts);
    case 'notify':
      return cmdNotify(opts);
    case 'status':
      return cmdStatus(opts);
    case 'doctor':
      return cmdDoctor();
    default:
      process.stderr.write(`未知命令 ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`bridge: ${err?.stack || err}\n`);
    process.exit(1);
  });
