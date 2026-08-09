/**
 * preload：contextBridge 暴露 `window.modou`（渲染进程唯一入口）。
 *
 * 安全边界：contextIsolation + 无 nodeIntegration——渲染进程只能通过本桥与
 * 主进程通信，拿不到 Node 能力。事件流（EVENT）与配置摘要（READY）是
 * main→renderer 订阅式；Command 与查询是 renderer→main。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC, type PlanPayload, type ReadyPayload } from './ipc';
import type { Command, Envelope } from '@modou/core';

/** 渲染进程可见的桥 API（src/lib/ipc.ts 里的 ModouApi 与之一一对应）。 */
const api = {
  /** 订阅协议信封流；返回退订函数。 */
  onEvent(callback: (envelope: Envelope) => void): () => void {
    const listener = (_event: IpcRendererEvent, envelope: Envelope): void => {
      callback(envelope);
    };
    ipcRenderer.on(IPC.EVENT, listener);
    return () => {
      ipcRenderer.removeListener(IPC.EVENT, listener);
    };
  },
  /** 订阅配置摘要（启动一次 + 模型/会话切换后刷新）；返回退订函数。 */
  onReady(callback: (payload: ReadyPayload) => void): () => void {
    const listener = (
      _event: IpcRendererEvent,
      payload: ReadyPayload,
    ): void => {
      callback(payload);
    };
    ipcRenderer.on(IPC.READY, listener);
    return () => {
      ipcRenderer.removeListener(IPC.READY, listener);
    };
  },
  /** 订阅计划产出（/plan 面板开合）；返回退订函数。 */
  onPlan(callback: (payload: PlanPayload) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: PlanPayload): void => {
      callback(payload);
    };
    ipcRenderer.on(IPC.PLAN, listener);
    return () => {
      ipcRenderer.removeListener(IPC.PLAN, listener);
    };
  },
  /** 发送 core Command（submit / approve / interrupt / steer / slash / plan_*）。 */
  sendCommand(command: Command): void {
    ipcRenderer.send(IPC.COMMAND, command);
  },
  /** 可恢复会话列表（侧栏）。 */
  listSessions(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.LIST_SESSIONS);
  },
  /** 当前线程的展示消息（resume/clear 后播种历史）。 */
  getThread(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_THREAD);
  },
  /** /model 候选模型 ID（模型选择器）。 */
  listModels(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.LIST_MODELS);
  },
  /** 已发现技能清单（设置面板）。 */
  listSkills(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_SKILLS);
  },
  /** 当前上下文分项核算（/context 面板）。 */
  getContext(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_CONTEXT);
  },
  /** 配置摘要（设置面板 / 顶栏）。 */
  getConfig(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_CONFIG);
  },
  /** 可编辑设置（设置面板表单初值）。 */
  getSettings(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_SETTINGS);
  },
  /** 保存设置到项目 .modou/settings.json。 */
  saveSettings(patch: unknown): Promise<unknown> {
    return ipcRenderer.invoke(IPC.SAVE_SETTINGS, patch);
  },
  /** 读取主题（gui-state 持久化）。 */
  getTheme(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_THEME);
  },
  /** 设置主题。 */
  setTheme(theme: 'light' | 'dark' | 'system'): Promise<unknown> {
    return ipcRenderer.invoke(IPC.SET_THEME, theme);
  },
  /** 删除一条会话（侧栏）。 */
  deleteSession(sessionId: string): Promise<unknown> {
    return ipcRenderer.invoke(IPC.DELETE_SESSION, sessionId);
  },
  /** 重命名会话（标题映射存 gui-state；空标题 = 恢复默认）。返回新映射。 */
  renameSession(sessionId: string, title: string): Promise<unknown> {
    return ipcRenderer.invoke(IPC.RENAME_SESSION, sessionId, title);
  },
  /** 读取会话标题映射。 */
  getSessionTitles(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_SESSION_TITLES);
  },
  /** 重新生成最后一条回复（重试）。 */
  regenerate(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.REGENERATE);
  },
  /** 用系统文件管理器打开路径。 */
  openPath(path: string): void {
    void ipcRenderer.invoke(IPC.OPEN_PATH, path);
  },
  /** 读取供应商列表 + 当前模型。 */
  getProviders(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_PROVIDERS);
  },
  /** 保存供应商列表（不切换当前模型）。 */
  saveProviders(providers: unknown): Promise<void> {
    return ipcRenderer.invoke(IPC.SAVE_PROVIDERS, providers);
  },
  /** 切换当前模型（写 active + 重建 bridge）。 */
  setActiveModel(input: unknown): Promise<unknown> {
    return ipcRenderer.invoke(IPC.SET_ACTIVE_MODEL, input);
  },
  /** 从上游 /models 拉取模型列表。 */
  listRemoteModels(input: unknown): Promise<unknown> {
    return ipcRenderer.invoke(IPC.LIST_REMOTE_MODELS, input);
  },
  /** 读取额外技能扫描目录。 */
  getSkillDirs(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_SKILL_DIRS);
  },
  /** 保存额外技能扫描目录（重建 bridge 生效）。 */
  setSkillDirs(dirs: readonly string[]): void {
    void ipcRenderer.invoke(IPC.SET_SKILL_DIRS, dirs);
  },
  /** 读取自定义 agent 文件内容。 */
  readAgent(name: string): Promise<unknown> {
    return ipcRenderer.invoke(IPC.READ_AGENT, name);
  },
  /** 写入自定义 agent 文件（重建 bridge 生效）。 */
  writeAgent(name: string, content: string): Promise<unknown> {
    return ipcRenderer.invoke(IPC.WRITE_AGENT, name, content);
  },
  /** 删除自定义 agent 文件（重建 bridge 生效）。 */
  deleteAgent(name: string): Promise<unknown> {
    return ipcRenderer.invoke(IPC.DELETE_AGENT, name);
  },
  /** 读取定时任务列表。 */
  getTasks(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_TASKS);
  },
  /** 保存定时任务列表。 */
  saveTasks(tasks: unknown): Promise<unknown> {
    return ipcRenderer.invoke(IPC.SAVE_TASKS, tasks);
  },
  /** 选择图片附件（系统对话框，返回 data URI 数组）。 */
  selectImages(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.SELECT_IMAGES);
  },
  /** 打开目录选择器选项目目录（选定后主进程重建 bridge）。 */
  selectDirectory(): Promise<{ ok: boolean; cwd: string | null }> {
    return ipcRenderer.invoke(IPC.SELECT_DIRECTORY);
  },
  /** 快照点列表（/rewind 面板）。 */
  getSnapshots(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_SNAPSHOTS);
  },
  /** 回滚预览（/rewind 确认态）。 */
  previewRewind(snapshotId: string): Promise<unknown> {
    return ipcRenderer.invoke(IPC.PREVIEW_REWIND, snapshotId);
  },
  /** 执行还原到某快照点。 */
  rewindTo(snapshotId: string): Promise<unknown> {
    return ipcRenderer.invoke(IPC.REWIND_TO, snapshotId);
  },
  /** 快照占用与保留报告（/snapshots）。 */
  snapshotReport(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.SNAPSHOT_REPORT);
  },
  /** 快照过期清理（/snapshots --cleanup）。 */
  snapshotCleanup(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.SNAPSHOT_CLEANUP);
  },
  /** 成本统计（/cost）。 */
  getCost(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_COST);
  },
  /** MCP 服务器状态（/mcp）。 */
  getMcpStatus(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_MCP_STATUS);
  },
  /** 探测仓库并生成 AGENTS.md 初稿（/init 预览）。 */
  planInit(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.PLAN_INIT);
  },
  /** 写入 /init 生成的 AGENTS.md 初稿。 */
  writeInit(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.WRITE_INIT);
  },
  /** 当前计划模式状态（/plan 面板拉取）。 */
  getPlan(): Promise<unknown> {
    return ipcRenderer.invoke(IPC.GET_PLAN);
  },
  /** 退出应用。 */
  quit(): void {
    void ipcRenderer.invoke(IPC.QUIT);
  },
};

contextBridge.exposeInMainWorld('modou', api);

export type ModouApi = typeof api;
