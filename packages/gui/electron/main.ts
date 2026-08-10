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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { IPC, type ReadyPayload } from './ipc';
import type {
  ActiveModel,
  ProviderEntry,
  ProviderState,
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
  new Notification({
    title: 'modou 已完成',
    body: '当前任务已完成，可以查看结果了。',
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
