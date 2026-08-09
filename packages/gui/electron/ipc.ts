/**
 * GUI IPC 契约：主进程 ↔ 渲染进程的通道常量与共享类型。
 *
 * 与 core 事件流协议（002 3.3）的分层关系：
 * - 协议信封（Envelope）经 `EVENT` 通道 main→renderer 单向推送——渲染进程是
 *   事件流的**纯消费者**，与 TUI App 同构（只读信封，不持有 core 内部对象）；
 * - `READY` 通道 main→renderer 推送配置摘要（启动时一次，模型/会话切换后刷新）：
 *   供状态栏 / 设置面板 / 顶栏展示，是 TUI 中「runTui 注入 App 的 prop」的
 *   IPC 对应物（modelName / permissionMode / cwd…），不属于协议信封；
 * - `COMMAND` 通道 renderer→main 回传 core Command（002 3.3 反向通道）；
 * - 其余 invoke 通道是「拉取型」控制面：会话列表 / 模型候选 / 上下文核算 /
 *   配置摘要 / 删除会话 / 退出。UI 模态需要的即时数据走 request/response，
 *   比再造协议事件更直接。
 */
export const IPC = {
  /** main → renderer：协议信封（Envelope）。 */
  EVENT: 'modou:event',
  /** main → renderer：配置摘要（ReadyPayload）。 */
  READY: 'modou:ready',
  /** main → renderer：计划产出（PlanPayload；/plan 面板开合）。 */
  PLAN: 'modou:plan',
  /** renderer → main：core Command（send，一次性）。 */
  COMMAND: 'modou:command',
  /** renderer → main（invoke）：可恢复会话列表。 */
  LIST_SESSIONS: 'modou:listSessions',
  /** renderer → main（invoke）：当前线程的展示消息（resume/clear 后播种）。 */
  GET_THREAD: 'modou:getThread',
  /** renderer → main（invoke）：/model 候选模型 ID 列表。 */
  LIST_MODELS: 'modou:listModels',
  /** renderer → main（invoke）：已发现技能清单（设置面板）。 */
  GET_SKILLS: 'modou:getSkills',
  /** renderer → main（invoke）：当前上下文分项核算（/context 面板）。 */
  GET_CONTEXT: 'modou:getContext',
  /** renderer → main（invoke）：配置摘要（设置面板）。 */
  GET_CONFIG: 'modou:getConfig',
  /** renderer → main（invoke）：删除一条会话（侧栏）。 */
  DELETE_SESSION: 'modou:deleteSession',
  /** renderer → main（invoke）：打开目录选择器选项目目录（重建 bridge）。 */
  SELECT_DIRECTORY: 'modou:selectDirectory',
  /** renderer → main（invoke）：快照点列表（/rewind 面板）。 */
  GET_SNAPSHOTS: 'modou:getSnapshots',
  /** renderer → main（invoke）：回滚预览（/rewind 确认态）。 */
  PREVIEW_REWIND: 'modou:previewRewind',
  /** renderer → main（invoke）：执行还原到某快照点。 */
  REWIND_TO: 'modou:rewindTo',
  /** renderer → main（invoke）：快照占用与保留报告（/snapshots）。 */
  SNAPSHOT_REPORT: 'modou:snapshotReport',
  /** renderer → main（invoke）：快照过期清理（/snapshots --cleanup）。 */
  SNAPSHOT_CLEANUP: 'modou:snapshotCleanup',
  /** renderer → main（invoke）：成本统计（/cost）。 */
  GET_COST: 'modou:getCost',
  /** renderer → main（invoke）：MCP 服务器状态（/mcp）。 */
  GET_MCP_STATUS: 'modou:getMcpStatus',
  /** renderer → main（invoke）：探测仓库并生成 AGENTS.md 初稿（/init 预览）。 */
  PLAN_INIT: 'modou:planInit',
  /** renderer → main（invoke）：写入 /init 生成的 AGENTS.md 初稿。 */
  WRITE_INIT: 'modou:writeInit',
  /** renderer → main（invoke）：当前计划模式状态（/plan 面板拉取）。 */
  GET_PLAN: 'modou:getPlan',
  /** renderer → main（invoke）：退出应用。 */
  QUIT: 'modou:quit',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** 启动 / 刷新时推给渲染进程的配置摘要（TUI runTui 注入 App 的 prop 的对应物）。 */
export interface ReadyPayload {
  /** 当前模型名（provider.modelId）。 */
  readonly modelName: string;
  /** 权限模式（从工具注册表推导：只读 / 写·执行需审批）。 */
  readonly permissionMode: PermissionMode;
  /** 工作目录（会话边界基准）。 */
  readonly cwd: string;
  /** 用户主目录（会话/日志根）。 */
  readonly homeDir: string;
  /** 项目名（cwd 的 basename，顶栏 / 侧栏标题用）。 */
  readonly projectName: string;
  /** 当前会话 ID（首轮前为 null）。 */
  readonly sessionId: string | null;
  /** 版本号。 */
  readonly version: string;
  /** resume/clear 后校准的累计 token（缺省 = 渲染进程保持现状）。 */
  readonly totals?: TokenTotals;
}

/** 一条线程展示消息（GET_THREAD 的返回；渲染进程据此播种会话历史）。 */
export interface ThreadMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

import type { PermissionMode, TokenTotals } from './status';
export type { PermissionMode } from './status';

/** 配置摘要（设置面板 / 顶栏展示；GET_CONFIG 的返回）。 */
export interface GuiConfigSummary {
  readonly version: string;
  readonly modelName: string;
  readonly providerType: string;
  readonly permissionMode: PermissionMode;
  readonly sandbox: string;
  readonly policy: string;
  readonly cwd: string;
  readonly homeDir: string;
  readonly projectName: string;
  readonly maxTurns: number;
  readonly keepTurns: number;
  readonly sessionId: string | null;
}

/** 计划产出（PLAN 通道 / GET_PLAN 返回）：null = 计划模式关闭或暂无计划。 */
export interface PlanPayload {
  /** 结构化计划（非空 = 计划面板打开）。 */
  readonly plan: StructuredPlan | null;
  /** 计划模式是否处于激活（只读研究中）。 */
  readonly active: boolean;
}

import type { StructuredPlan } from '@modou/core';
export type {
  CostTotals,
  DayCostTotals,
  InitResult,
  McpServerStatus,
  RewindPreview,
  RewindResult,
  SnapshotPoint,
  SnapshotUsageReport,
} from '@modou/core';
