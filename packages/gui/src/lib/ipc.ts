/**
 * 渲染进程对 `window.modou` 的类型声明（与 electron/preload.ts 的 API 对应）。
 *
 * 渲染进程是事件流的纯消费者 + Command 的发送者（002 3.3）：不持有 core 内部
 * 对象，一切状态来自协议信封 / READY 摘要 / invoke 查询结果。
 */
import type {
  Command,
  ContextStateData,
  Envelope,
  ResumeCandidate,
} from '@modou/core';
import type {
  GuiConfigSummary,
  ReadyPayload,
  ThreadMessage,
} from '../../electron/ipc';

/** preload 暴露的桥（window.modou）。 */
export interface ModouApi {
  /** 订阅协议信封流；返回退订函数。 */
  onEvent(callback: (envelope: Envelope) => void): () => void;
  /** 订阅配置摘要（启动一次 + 模型/会话切换后刷新）；返回退订函数。 */
  onReady(callback: (payload: ReadyPayload) => void): () => void;
  /** 发送 core Command（submit / approve / interrupt / steer / slash）。 */
  sendCommand(command: Command): void;
  /** 可恢复会话列表（侧栏）。 */
  listSessions(): Promise<readonly ResumeCandidate[]>;
  /** 当前线程的展示消息（resume/clear 后播种历史）。 */
  getThread(): Promise<readonly ThreadMessage[] | null>;
  /** /model 候选模型 ID（模型选择器）。 */
  listModels(): Promise<readonly string[]>;
  /** 当前上下文分项核算（/context 面板）。 */
  getContext(): Promise<ContextStateData | null>;
  /** 配置摘要（设置面板 / 顶栏）。 */
  getConfig(): Promise<GuiConfigSummary | null>;
  /** 删除一条会话（侧栏）。 */
  deleteSession(sessionId: string): Promise<boolean>;
  /** 打开目录选择器选项目目录（选定后主进程重建 bridge，READY 会随后到达）。 */
  selectDirectory(): Promise<{ ok: boolean; cwd: string | null }>;
  /** 退出应用。 */
  quit(): void;
}

declare global {
  interface Window {
    readonly modou: ModouApi;
  }
}
