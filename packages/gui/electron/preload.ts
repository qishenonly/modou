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
  /** 删除一条会话（侧栏）。 */
  deleteSession(sessionId: string): Promise<unknown> {
    return ipcRenderer.invoke(IPC.DELETE_SESSION, sessionId);
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
