/**
 * Electron 主进程入口：窗口管理 + 把 GuiBridge 接到 IPC。
 *
 * 分层：bridge.ts 不 import 'electron'（可单测），本文件只做接线——
 * - `ipcMain.handle` 把渲染进程的「拉取型」invoke 接到桥的查询方法；
 * - `ipcMain.on(COMMAND)` 把 Command 交给 bridge.sendCommand；
 * - 桥的 emitEvent → webContents.send(EVENT)；emitReady → send(READY)。
 *
 * 项目目录（= agent 的工作目录 / 沙箱边界）：
 * - 启动时读取 `~/.modou/gui-state.json` 的 lastDirectory；存在且有效则在
 *   该目录装配 bridge，否则桥置空（渲染进程显示「选择项目目录」欢迎页）；
 * - 用户经 SELECT_DIRECTORY 选择目录后：持久化 → 重建 bridge（新 cwd）→
 *   推 READY；切换目录同理（旧 bridge dispose，新 bridge 从零开始）。
 *
 * .env 加载：TUI 靠 bun 自动加载 .env，Electron 主进程不会——这里在装配
 * provider 前从 cwd 向上搜索 .env 并注入 process.env（已存在的变量不覆盖）。
 * 装配失败（如缺 API Key）时窗口照常打开、推一条 error notice 给渲染进程，
 * IPC handler 仍注册（空桥兜底），避免「No handler registered」刷屏。
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  shell,
} from 'electron';
import { GuiBridge } from './bridge';
import { parseGitStatus } from './gitparse';
import { IPC, type ReadyPayload } from './ipc';
import type {
  ActiveModel,
  FileTreeNode,
  FileTreeResult,
  GitDiffResult,
  GitStatusResult,
  ProviderEntry,
  ProviderState,
  ReadFileResult,
  RemoteModelsResult,
  ScheduledTask,
} from './ipc';
import type { Command, Envelope } from '@modou/core';

const isDev = process.env.MODOU_GUI_DEV === '1';
const devUrl = process.env.MODOU_GUI_DEV_URL ?? 'http://localhost:5173';
// ESM 下无 __dirname：从 import.meta.url 换算（bundle 输出 .mjs，原生 ESM）
const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let bridge: GuiBridge | null = null;
/** 本轮 turn_start 的时间戳（长任务完成通知的「用时」来源）。 */
let turnStartedAt: number | null = null;
/** 当前装配的桥的工作目录（saveSettings 重建用）。 */
let currentCwd: string | undefined = undefined;

// ---------------------------------------------------------------------------
// .env 加载（向上搜索，已存在的变量不覆盖）
// ---------------------------------------------------------------------------

/** 解析一行 KEY=VALUE（支持 # 注释与可选引号）。 */
function applyEnvLine(line: string): void {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return;
  const eq = trimmed.indexOf('=');
  if (eq < 0) return;
  const key = trimmed.slice(0, eq).trim();
  const raw = trimmed.slice(eq + 1).trim();
  const value = raw.replace(/^["']|["']$/g, '');
  if (key.length > 0 && process.env[key] === undefined) {
    process.env[key] = value;
  }
}

/** 从 startDir 向上搜索 .env（最多 6 层），把未设置的环境变量注入 process.env。 */
function loadEnvUpward(startDir: string): void {
  let dir = startDir;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, 'utf8').split('\n')) {
        applyEnvLine(line);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

// 在装配 provider 前注入 .env（MODOU_OPENCODE_* 等；显式环境变量优先）
loadEnvUpward(process.cwd());

// ---------------------------------------------------------------------------
// GUI 本地状态（~/.modou/gui-state.json：最近使用的项目目录等）
// ---------------------------------------------------------------------------

const guiStateFile = join(homedir(), '.modou', 'gui-state.json');

interface GuiStateFile {
  readonly lastDirectory?: string;
  readonly lastTheme?: 'light' | 'dark' | 'system';
  /** 会话标题映射（重命名；key = sessionId）。 */
  readonly sessionTitles?: Readonly<Record<string, string>>;
  /** 额外技能扫描目录（Skills 面板配置的自定义技能根）。 */
  readonly skillsDirs?: readonly string[];
  /** bash 工具默认超时（毫秒；设置面板配置）。 */
  readonly bashTimeoutMs?: number;
  /** 已归档会话 ID（归档后从侧栏主列表隐藏，可移出恢复）。 */
  readonly archivedSessions?: readonly string[];
}

function readGuiState(): GuiStateFile {
  try {
    const parsed = JSON.parse(
      readFileSync(guiStateFile, 'utf8'),
    ) as GuiStateFile;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeGuiState(state: GuiStateFile): void {
  try {
    mkdirSync(dirname(guiStateFile), { recursive: true });
    writeFileSync(guiStateFile, JSON.stringify(state, null, 2));
  } catch (caught) {
    console.warn(
      '[modou-gui] 无法写 gui-state：',
      caught instanceof Error ? caught.message : String(caught),
    );
  }
}

// ---------------------------------------------------------------------------
// 模型管理（ccswitch 式：多供应商 / 中转站 / 源头；~/.modou/providers.json）
// ---------------------------------------------------------------------------

const providersFile = join(homedir(), '.modou', 'providers.json');

interface ProvidersFileShape {
  readonly providers?: readonly ProviderEntry[];
  readonly active?: ActiveModel | null;
}

function readProviders(): ProviderState {
  try {
    const parsed = JSON.parse(
      readFileSync(providersFile, 'utf8'),
    ) as ProvidersFileShape;
    if (typeof parsed !== 'object' || parsed === null) {
      return { providers: [], active: null };
    }
    return {
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
      active: parsed.active ?? null,
    };
  } catch {
    return { providers: [], active: null };
  }
}

function writeProviders(state: ProviderState): void {
  try {
    mkdirSync(dirname(providersFile), { recursive: true });
    writeFileSync(providersFile, JSON.stringify(state, null, 2));
  } catch (caught) {
    console.warn(
      '[modou-gui] 无法写 providers.json：',
      caught instanceof Error ? caught.message : String(caught),
    );
  }
}

/**
 * 把当前生效模型注入 core 环境变量（装配 bridge 时调用）。
 * core resolveConfig 顺序：settings.json → MODOU_* 环境变量 → 显式覆盖，
 * 因此 MODOU_PROVIDER/MODOU_MODEL/MODOU_BASE_URL 覆盖配置文件；API Key 按
 * 供应商类型写 OPENAI_API_KEY / ANTHROPIC_API_KEY。
 */
function applyActiveEnv(active: ActiveModel | null): void {
  if (active === null) return;
  process.env.MODOU_PROVIDER = active.type;
  process.env.MODOU_MODEL = active.model;
  if (active.baseURL.length > 0) process.env.MODOU_BASE_URL = active.baseURL;
  if (active.type === 'anthropic') {
    process.env.ANTHROPIC_API_KEY = active.apiKey;
  } else {
    process.env.OPENAI_API_KEY = active.apiKey;
  }
}

/** 从上游 OpenAI 兼容 `/models` 端点拉取模型列表（主进程 fetch，无 CORS 限制）。 */
async function listRemoteModels(input: {
  readonly baseURL: string;
  readonly apiKey: string;
}): Promise<RemoteModelsResult> {
  const base = input.baseURL.trim().replace(/\/+$/, '');
  if (base.length === 0)
    return { ok: false, models: [], message: 'baseURL 为空' };
  // OpenAI 兼容中转站端点形态不统一：先试 {base}/models，若 base 不以
  // /v1 结尾再试 {base}/v1/models（很多中转站只认 /v1 前缀）。Anthropic
  // 官方是 {base}/v1/models（直接数组）。失败返回最近一次错误信息。
  const candidates: readonly string[] = [
    `${base}/models`,
    ...(/\/(v1|api)$/.test(base) ? [] : [`${base}/v1/models`]),
  ];
  let lastMessage = '未知错误';
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${input.apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        lastMessage = `HTTP ${res.status}（${url}）${
          body.length > 0 ? `：${body.slice(0, 120)}` : ''
        }`;
        continue;
      }
      const data = (await res.json()) as unknown;
      // OpenAI 兼容：{ data: [{ id }] }；Anthropic：直接数组
      const wrapped = (data as { data?: Array<{ id?: unknown }> }).data;
      const models = Array.isArray(wrapped)
        ? wrapped
            .map((item) => (typeof item.id === 'string' ? item.id : ''))
            .filter((id) => id.length > 0)
        : Array.isArray(data)
          ? (data as Array<{ id?: unknown }>)
              .map((item) => (typeof item.id === 'string' ? item.id : ''))
              .filter((id) => id.length > 0)
          : [];
      if (models.length > 0) return { ok: true, models };
      return { ok: true, models, message: '接口返回为空（端点可能不对）' };
    } catch (caught) {
      lastMessage = caught instanceof Error ? caught.message : String(caught);
    }
  }
  return { ok: false, models: [], message: `拉取失败：${lastMessage}` };
}

// ---------------------------------------------------------------------------
// 文件系统面板（T-1：文件树 / 预览 / git 状态）
// ---------------------------------------------------------------------------

/** 文件树遍历时跳过的目录 / 文件名（忽略规则）。 */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.modou',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.DS_Store',
]);
const FILE_TREE_MAX_DEPTH = 8;
const FILE_TREE_MAX_NODES = 3000;
const PREVIEW_LIMIT = 512 * 1024;
const GIT_DIFF_LIMIT = 2 * 1024 * 1024;

/** 执行 git 子命令，返回退出码与输出（超时 10s；命令不存在返回 127）。 */
function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: 10_000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise({ code: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === 'number') {
          // git 正常执行但非零退出（如非 git 仓库），保留真实退出码与输出
          resolvePromise({ code: error.code, stdout, stderr });
          return;
        }
        // 命令不存在 / 无法启动：归为 127
        resolvePromise({ code: 127, stdout: '', stderr: error.message });
      },
    );
  });
}

/** 递归构建文件树（目录在前、文件在后，各自按名字典序；忽略规则见 SKIP_DIRS）。 */
function buildFileTree(cwd: string): FileTreeResult {
  try {
    let nodeCount = 0;
    const walk = (dir: string, rel: string, depth: number): FileTreeNode[] => {
      // 深度或节点数超限就停止向下
      if (depth > FILE_TREE_MAX_DEPTH || nodeCount >= FILE_TREE_MAX_NODES) {
        return [];
      }
      const dirs: FileTreeNode[] = [];
      const files: FileTreeNode[] = [];
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue; // 符号链接跳过，防环
          const name = entry.name;
          if (SKIP_DIRS.has(name)) continue;
          if (nodeCount >= FILE_TREE_MAX_NODES) break;
          const childRel = rel.length === 0 ? name : `${rel}/${name}`;
          if (entry.isDirectory()) {
            nodeCount += 1;
            dirs.push({
              name,
              path: childRel,
              type: 'dir',
              children: walk(join(dir, name), childRel, depth + 1),
            });
          } else if (entry.isFile()) {
            nodeCount += 1;
            let size = 0;
            let mtime = 0;
            try {
              const st = statSync(join(dir, name));
              size = st.size;
              mtime = st.mtimeMs;
            } catch {
              // statSync 失败给 0
            }
            files.push({ name, path: childRel, type: 'file', size, mtime });
          }
          // 其余类型（socket/fifo 等）忽略
        }
      } catch {
        return [];
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => a.name.localeCompare(b.name));
      return [...dirs, ...files];
    };
    const tree = walk(cwd, '', 0);
    return { ok: true, root: cwd, tree };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { ok: false, root: cwd, tree: null, message };
  }
}

/** 把相对路径限定在 cwd 内（防路径穿越）；越界返回 null。 */
function resolveWithin(cwd: string, relPath: string): string | null {
  if (relPath.length === 0 || relPath.startsWith('/')) return null;
  const resolved = resolve(cwd, relPath);
  if (resolved === cwd) return cwd;
  return resolved.startsWith(cwd + sep) ? resolved : null;
}

/** 读取文件预览（超 PREVIEW_LIMIT 截断；前 8192 字节含 NUL 判二进制）。 */
function readFilePreview(cwd: string, relPath: string): ReadFileResult {
  const resolved = resolveWithin(cwd, relPath);
  if (resolved === null || !existsSync(resolved)) {
    return {
      ok: false,
      path: relPath,
      content: null,
      binary: false,
      truncated: false,
      message: '路径无效或文件不存在',
    };
  }
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) {
      return {
        ok: false,
        path: relPath,
        content: null,
        binary: false,
        truncated: false,
        message: '不是文件',
      };
    }
    const full = readFileSync(resolved);
    const truncated = full.length > PREVIEW_LIMIT;
    const buffer = truncated ? full.subarray(0, PREVIEW_LIMIT) : full;
    if (buffer.subarray(0, 8192).includes(0)) {
      return {
        ok: true,
        path: relPath,
        content: null,
        binary: true,
        truncated,
      };
    }
    return {
      ok: true,
      path: relPath,
      content: buffer.toString('utf8'),
      binary: false,
      truncated,
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return {
      ok: false,
      path: relPath,
      content: null,
      binary: false,
      truncated: false,
      message,
    };
  }
}

/** git 工作区状态（非 git 仓库降级为 git:false）。 */
async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  const status = await runGit(cwd, ['status', '--porcelain']);
  if (status.code !== 0) {
    return { ok: true, git: false, changes: [] };
  }
  const unstaged = await runGit(cwd, ['diff', '--numstat']);
  const staged = await runGit(cwd, ['diff', '--cached', '--numstat']);
  const changes = parseGitStatus(status.stdout, unstaged.stdout, staged.stdout);
  return { ok: true, git: true, changes };
}

/** 逐文件 unified diff（unstaged + staged 拼接；untracked 用全文）。 */
async function getGitDiff(
  cwd: string,
  relPath: string,
): Promise<GitDiffResult> {
  if (resolveWithin(cwd, relPath) === null) {
    return {
      ok: false,
      path: relPath,
      diff: '',
      untracked: false,
      message: '路径无效',
    };
  }
  const unstaged = await runGit(cwd, ['diff', '--', relPath]);
  const staged = await runGit(cwd, ['diff', '--cached', '--', relPath]);
  const parts: string[] = [];
  if (unstaged.stdout.length > 0) parts.push(unstaged.stdout);
  if (staged.stdout.length > 0) parts.push(staged.stdout);
  let diff = parts.join('\n');
  if (diff.length > 0) {
    if (diff.length > GIT_DIFF_LIMIT) {
      diff = diff.slice(0, GIT_DIFF_LIMIT);
      return {
        ok: true,
        path: relPath,
        diff,
        untracked: false,
        message: 'diff 过大，已截断',
      };
    }
    return { ok: true, path: relPath, diff, untracked: false };
  }
  // 两段都为空：用 porcelain 判断是否未跟踪文件，是则读全文作为 diff
  const status = await runGit(cwd, ['status', '--porcelain', '--', relPath]);
  if (status.code === 0 && status.stdout.startsWith('??')) {
    const preview = readFilePreview(cwd, relPath);
    if (preview.ok && preview.content !== null) {
      return {
        ok: true,
        path: relPath,
        diff: preview.content,
        untracked: true,
      };
    }
    return {
      ok: false,
      path: relPath,
      diff: '',
      untracked: true,
      message: preview.message ?? '无法读取未跟踪文件',
    };
  }
  return { ok: true, path: relPath, diff: '', untracked: false };
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'modou — 墨斗',
    backgroundColor: '#FAF9F5',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 用 contextBridge，需要 node 能力
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 外链（帮助 / 文档）一律交给系统浏览器，不劫持到应用内窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 向渲染进程推一条协议信封（窗口存活时）。 */
function sendEvent(envelope: Envelope): void {
  if (envelope.agent === 'main' && envelope.type === 'turn_start') {
    turnStartedAt = Date.now();
  }
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.EVENT, envelope);
  }
  maybeNotifyTurnEnd(envelope);
}

/** 长任务完成通知：turn 正常结束且窗口未聚焦时发系统通知（Claude 式）。 */
function maybeNotifyTurnEnd(envelope: Envelope): void {
  if (envelope.type !== 'turn_end') return;
  if (envelope.data.termination !== 'end_turn') return;
  if (
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    mainWindow.isFocused()
  ) {
    return;
  }
  if (!Notification.isSupported()) return;
  const elapsed =
    turnStartedAt !== null
      ? `（用时 ${Math.max(1, Math.round((Date.now() - turnStartedAt) / 1000))} 秒）`
      : '';
  turnStartedAt = null;
  new Notification({
    title: 'modou 已完成',
    body: `当前任务已完成，可以查看结果了。${elapsed}`,
  }).show();
}

/** 向渲染进程推配置摘要（READY）。 */
function sendReady(payload: ReadyPayload): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.READY, payload);
  }
}

// ---------------------------------------------------------------------------
// 桥装配 / 切换
// ---------------------------------------------------------------------------

/** 在指定目录装配桥（缺省 undefined = 尚无项目，桥置空）；失败不崩溃。 */
function createBridge(cwd?: string): void {
  bridge?.dispose();
  bridge = null;
  currentCwd = cwd;
  if (cwd === undefined) return;
  try {
    const guiState = readGuiState();
    const skillsDirs = guiState.skillsDirs;
    const bashTimeoutMs = guiState.bashTimeoutMs;
    bridge = new GuiBridge(
      {
        cwd,
        ...(skillsDirs !== undefined && skillsDirs.length > 0
          ? { skillsDirs }
          : {}),
        ...(bashTimeoutMs !== undefined && bashTimeoutMs > 0
          ? { bashTimeoutMs }
          : {}),
      },
      {
        emitEvent: sendEvent,
        emitReady: sendReady,
        emitPlan: (payload) => {
          if (mainWindow !== null && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC.PLAN, payload);
          }
        },
      },
    );
    sendReady(bridge.start());
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error('[modou-gui] 启动装配失败：', message);
    sendEvent({
      v: 1,
      seq: 1,
      ts: Date.now(),
      agent: 'main',
      turn: 0,
      type: 'notice',
      data: {
        level: 'error',
        text: `启动失败：${message}。请检查 API Key 配置（~/.modou/settings.json 或 .env）。`,
      },
    });
  }
}

/** 打开系统目录选择器，选定后持久化并重建桥（返回结果给渲染进程）。 */
async function handleSelectDirectory(): Promise<{
  readonly ok: boolean;
  readonly cwd: string | null;
}> {
  if (mainWindow === null) return { ok: false, cwd: null };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择项目目录',
    buttonLabel: '在此目录启动 modou',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, cwd: null };
  }
  const dir = result.filePaths[0];
  writeGuiState({ lastDirectory: dir });
  createBridge(dir);
  return { ok: true, cwd: dir };
}

// ---------------------------------------------------------------------------
// IPC 接线（handler 无论桥是否存在都注册，查询侧有 ?? 兜底）
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.on(IPC.COMMAND, (_event, command: Command) => {
    bridge?.sendCommand(command);
  });
  ipcMain.handle(IPC.LIST_SESSIONS, () => bridge?.listSessions() ?? []);
  ipcMain.handle(IPC.GET_THREAD, () => bridge?.getThread() ?? []);
  ipcMain.handle(
    IPC.SEARCH_SESSIONS,
    async (_event, query: string, allProjects?: boolean) =>
      (await bridge?.searchSessions(query, allProjects === true)) ?? [],
  );
  ipcMain.handle(
    IPC.GET_THREAD_DETAILED,
    () => bridge?.getThreadDetailed() ?? [],
  );
  ipcMain.handle(IPC.EXPORT_SESSION, async (_event, sessionId: string) => {
    if (bridge === null) return { ok: false, message: '未选择项目目录' };
    const markdown = await bridge.renderSessionMarkdown(sessionId);
    if (markdown === null) return { ok: false, message: '会话不存在' };
    if (mainWindow === null) return { ok: false, message: '窗口不可用' };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出会话',
      defaultPath: `modou-${sessionId.slice(0, 8)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || result.filePath === undefined) {
      return { ok: false, message: '已取消' };
    }
    try {
      writeFileSync(result.filePath, markdown, 'utf8');
      return { ok: true, path: result.filePath };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return { ok: false, message: `写入失败：${message}` };
    }
  });
  ipcMain.handle(IPC.LIST_MODELS, () => bridge?.listModels() ?? []);
  ipcMain.handle(IPC.GET_SKILLS, () => bridge?.listSkills() ?? []);
  ipcMain.handle(IPC.GET_CONTEXT, () => bridge?.getContext() ?? null);
  ipcMain.handle(IPC.GET_CONFIG, () => bridge?.getConfig() ?? null);
  ipcMain.handle(IPC.GET_SETTINGS, () => bridge?.getSettings() ?? null);
  ipcMain.handle(
    IPC.SAVE_SETTINGS,
    async (_event, patch: Parameters<GuiBridge['saveSettings']>[0]) => {
      const result = await bridge?.saveSettings(patch);
      const outcome = result ?? { ok: false, needRestart: false };
      // 权限/供应商/上下文类改动：保存后自动重建桥（新配置立即生效）
      if (outcome.ok && outcome.needRestart) {
        createBridge(currentCwd);
      }
      return outcome;
    },
  );
  ipcMain.handle(IPC.GET_THEME, () => readGuiState().lastTheme ?? 'system');
  ipcMain.handle(
    IPC.SET_THEME,
    (_event, theme: 'light' | 'dark' | 'system') => {
      writeGuiState({ ...readGuiState(), lastTheme: theme });
    },
  );
  ipcMain.handle(
    IPC.GET_SESSION_TITLES,
    () => readGuiState().sessionTitles ?? {},
  );
  ipcMain.handle(
    IPC.RENAME_SESSION,
    (_event, sessionId: string, title: string) => {
      const state = readGuiState();
      const trimmed = title.trim();
      const titles = { ...(state.sessionTitles ?? {}) };
      if (trimmed.length === 0) {
        delete titles[sessionId];
      } else {
        titles[sessionId] = trimmed;
      }
      writeGuiState({ ...state, sessionTitles: titles });
      return titles;
    },
  );
  ipcMain.handle(IPC.REGENERATE, () => bridge?.regenerate() ?? false);
  ipcMain.handle(IPC.OPEN_PATH, (_event, path: string) => {
    void shell.openPath(path);
  });
  // —— 模型管理（ccswitch 式）——
  ipcMain.handle(IPC.GET_PROVIDERS, () => readProviders());
  ipcMain.handle(
    IPC.SAVE_PROVIDERS,
    (_event, providers: readonly ProviderEntry[]) => {
      const state = readProviders();
      const active =
        state.active !== null &&
        providers.some((provider) => provider.id === state.active?.providerId)
          ? state.active
          : null;
      writeProviders({ providers, active });
    },
  );
  ipcMain.handle(
    IPC.SET_ACTIVE_MODEL,
    (
      _event,
      input: { readonly providerId: string; readonly model: string },
    ) => {
      const state = readProviders();
      const provider = state.providers.find((p) => p.id === input.providerId);
      if (provider === undefined) {
        return { ok: false, message: '供应商不存在' };
      }
      const active: ActiveModel = {
        providerId: provider.id,
        type: provider.type,
        model: input.model,
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
      };
      writeProviders({ providers: state.providers, active });
      applyActiveEnv(active);
      createBridge(currentCwd); // 重建 bridge 使新模型/供应商生效
      return { ok: true };
    },
  );
  ipcMain.handle(
    IPC.LIST_REMOTE_MODELS,
    (_event, input: { readonly baseURL: string; readonly apiKey: string }) =>
      listRemoteModels(input),
  );
  ipcMain.handle(IPC.GET_SKILL_DIRS, () => readGuiState().skillsDirs ?? []);
  ipcMain.handle(IPC.SELECT_SKILL_DIR, async () => {
    if (mainWindow === null) return { ok: false, path: null };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择技能目录（含 SKILL.md 的目录即可作为技能）',
      buttonLabel: '选择',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, path: null };
    }
    return { ok: true, path: result.filePaths[0] };
  });
  ipcMain.handle(IPC.GET_ARCHIVED, () => readGuiState().archivedSessions ?? []);
  ipcMain.handle(
    IPC.SET_ARCHIVED,
    (_event, sessionId: string, archived: boolean) => {
      const current = readGuiState().archivedSessions ?? [];
      const next = archived
        ? [...new Set([...current, sessionId])]
        : current.filter((id) => id !== sessionId);
      writeGuiState({ ...readGuiState(), archivedSessions: next });
      return next;
    },
  );
  ipcMain.handle(IPC.SET_SKILL_DIRS, (_event, dirs: readonly string[]) => {
    const cleaned = dirs
      .map((dir) => dir.trim())
      .filter((dir) => dir.length > 0);
    writeGuiState({ ...readGuiState(), skillsDirs: [...new Set(cleaned)] });
    createBridge(currentCwd); // 重建使新技能目录生效
  });
  ipcMain.handle(
    IPC.GET_BASH_TIMEOUT,
    () => readGuiState().bashTimeoutMs ?? 30_000,
  );
  ipcMain.handle(IPC.SET_BASH_TIMEOUT, (_event, ms: number) => {
    const value = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined;
    const state = readGuiState();
    writeGuiState({
      ...state,
      ...(value !== undefined ? { bashTimeoutMs: value } : {}),
    });
    createBridge(currentCwd); // 重建使新超时生效
  });
  // —— 自定义 agents（.modou/agents/<name>.md 文件读写；重建 bridge 生效）——
  const agentDir = (): string =>
    currentCwd === undefined ? '' : join(currentCwd, '.modou', 'agents');
  const agentPath = (name: string): string | null => {
    // 名字白名单：防路径穿越（只允许字母数字 _ -）
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;
    return join(agentDir(), `${name}.md`);
  };
  ipcMain.handle(IPC.READ_AGENT, (_event, name: string) => {
    const file = agentPath(name);
    if (file === null) return null;
    try {
      if (!existsSync(file)) return null;
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  });
  ipcMain.handle(IPC.WRITE_AGENT, (_event, name: string, content: string) => {
    const file = agentPath(name);
    if (file === null || currentCwd === undefined) return false;
    try {
      mkdirSync(agentDir(), { recursive: true });
      writeFileSync(file, content, 'utf8');
      createBridge(currentCwd); // 重建使新 agent 生效
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle(IPC.DELETE_AGENT, (_event, name: string) => {
    const file = agentPath(name);
    if (file === null || currentCwd === undefined) return false;
    try {
      if (existsSync(file)) rmSync(file, { force: true });
      createBridge(currentCwd);
      return true;
    } catch {
      return false;
    }
  });
  // —— 定时任务（GUI 管理；~/.modou/tasks.json；执行由应用运行期间调度）——
  const tasksFile = join(homedir(), '.modou', 'tasks.json');
  const readTasks = (): ScheduledTask[] => {
    try {
      const parsed = JSON.parse(readFileSync(tasksFile, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as ScheduledTask[]) : [];
    } catch {
      return [];
    }
  };
  ipcMain.handle(IPC.GET_TASKS, () => readTasks());
  ipcMain.handle(IPC.SAVE_TASKS, (_event, tasks: readonly ScheduledTask[]) => {
    try {
      mkdirSync(dirname(tasksFile), { recursive: true });
      writeFileSync(tasksFile, JSON.stringify(tasks, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle(IPC.SELECT_IMAGES, async () => {
    if (mainWindow === null) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择图片附件',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    const uris: string[] = [];
    for (const file of result.filePaths) {
      try {
        const ext = file.split('.').pop()?.toLowerCase() ?? 'png';
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        const data = readFileSync(file);
        uris.push(`data:image/${mime};base64,${data.toString('base64')}`);
      } catch {
        // 单张读取失败跳过，不阻塞其余
      }
    }
    return uris;
  });
  ipcMain.handle(IPC.SELECT_FILES, async () => {
    if (mainWindow === null) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择文件附件（文本类会被读入消息，图片作为图片附件）',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return result.filePaths;
  });
  ipcMain.handle(
    IPC.DELETE_SESSION,
    (_event, sessionId: string) => bridge?.deleteSession(sessionId) ?? false,
  );
  ipcMain.handle(IPC.SELECT_DIRECTORY, () => handleSelectDirectory());
  ipcMain.handle(IPC.GET_SNAPSHOTS, () => bridge?.listSnapshots() ?? []);
  ipcMain.handle(
    IPC.PREVIEW_REWIND,
    (_event, id: string) => bridge?.previewRewind(id) ?? null,
  );
  ipcMain.handle(
    IPC.REWIND_TO,
    (_event, id: string) => bridge?.rewindTo(id) ?? null,
  );
  ipcMain.handle(IPC.SNAPSHOT_REPORT, () => bridge?.snapshotReport() ?? null);
  ipcMain.handle(IPC.SNAPSHOT_CLEANUP, () => {
    void bridge?.snapshotCleanup();
    return null;
  });
  ipcMain.handle(IPC.GET_COST, () => bridge?.getCost() ?? null);
  ipcMain.handle(IPC.GET_MCP_STATUS, () => bridge?.getMcpStatus() ?? []);
  ipcMain.handle(IPC.PLAN_INIT, () => bridge?.planInit() ?? null);
  ipcMain.handle(IPC.WRITE_INIT, () => bridge?.writeInit() ?? false);
  ipcMain.handle(
    IPC.GET_PLAN,
    () => bridge?.getPlan() ?? { plan: null, active: false },
  );
  // —— 文件系统面板（T-1：文件树 / 预览 / git 状态）——
  ipcMain.handle(IPC.GET_FILE_TREE, () =>
    currentCwd === undefined
      ? {
          ok: false,
          root: '',
          tree: null,
          message: '未选择项目目录',
        }
      : buildFileTree(currentCwd),
  );
  ipcMain.handle(IPC.READ_FILE, (_event, path: string) =>
    currentCwd === undefined
      ? {
          ok: false,
          path,
          content: null,
          binary: false,
          truncated: false,
          message: '未选择项目目录',
        }
      : readFilePreview(currentCwd, path),
  );
  ipcMain.handle(IPC.GET_GIT_STATUS, () =>
    currentCwd === undefined
      ? {
          ok: false,
          git: false,
          changes: [],
          message: '未选择项目目录',
        }
      : getGitStatus(currentCwd),
  );
  ipcMain.handle(IPC.GET_GIT_DIFF, (_event, path: string) =>
    currentCwd === undefined
      ? {
          ok: false,
          path,
          diff: '',
          untracked: false,
          message: '未选择项目目录',
        }
      : getGitDiff(currentCwd, path),
  );
  ipcMain.handle(IPC.QUIT, () => {
    bridge?.dispose();
    app.quit();
  });
}

app.whenReady().then(() => {
  createWindow();
  registerIpc();

  // 启动：恢复最近使用的项目目录（存在且有效），否则等待用户选择
  const saved = readGuiState();
  const lastDirectory = saved.lastDirectory;
  if (lastDirectory !== undefined && existsSync(lastDirectory)) {
    applyActiveEnv(readProviders().active);
    createBridge(lastDirectory);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  bridge?.dispose();
  if (process.platform !== 'darwin') app.quit();
});
