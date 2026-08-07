/**
 * 事件流协议 —— core 对一切前端的唯一契约（design 002 第三节，3.1/3.2）。
 *
 * 演进约束（ADR 0003 定稿）：协议定稿后**只允许加字段，不做破坏性修改**。
 * - 新增事件类型 = 在 `EventType` 与 `ProtocolEvent` 联合各加一项 + 定义负载接口，
 *   不触碰既有条目（判别联合天然是增量友好的）；
 * - 扩展现有负载 = 给对应 `*Data` 接口加**可选**字段；
 * - 删除 / 重命名既有字段视为破坏性修改，需要评审。
 *
 * 类型层面：`ProtocolEvent` 是判别联合，消费方 switch 的 `default` 分支保证穷尽；
 * 新增事件类型只会让新消费者可选处理它，不会破坏既有消费者的编译。
 */

/** 事件类型全集（3.2 表。协议定稿：只加不改）。 */
export type EventType =
  | 'turn_start'
  | 'turn_end'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_call'
  | 'tool_progress'
  | 'tool_result'
  | 'approval_request'
  | 'approval_resolved'
  | 'usage'
  | 'context_state'
  | 'compaction'
  | 'notice'
  | 'error';

// ---------------------------------------------------------------------------
// 负载类型（字段与 3.2 表「负载要点」列一致）
// ---------------------------------------------------------------------------

/** turn_start：轮次开始（前端分组、状态复位用）。 */
export interface TurnStartData {
  readonly turn: number;
}

/**
 * turn 终止原因。与 runtime 内部 `TurnTermination` 同形（'end_turn' |
 * 'halted' | 'interrupted' | 'error'），但协议自持一份，不依赖 runtime。
 * T-014 引入退避重试后，`error` 的语义保持「本 turn 终结」，不在此处改。
 */
export type TurnEndTermination =
  'end_turn' | 'halted' | 'interrupted' | 'error';

/** turn_end：轮次结束，携带终止原因。 */
export interface TurnEndData {
  readonly turn: number;
  readonly termination: TurnEndTermination;
}

/** text_delta：文本增量（流式渲染）。 */
export interface TextDeltaData {
  readonly delta: string;
}

/** thinking_delta：推理增量（供应商支持时透出，可折叠展示）。 */
export interface ThinkingDeltaData {
  readonly delta: string;
}

/** tool_call：模型请求调用工具（展示「正在做什么」）。 */
export interface ToolCallData {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** tool_progress：长命令的活性反馈（如 bash 实时输出）。0.1.0 不产生。 */
export interface ToolProgressData {
  readonly id: string;
  readonly text: string;
}

/**
 * tool_result：区分「给模型看的文本」与「给人看的结构化载荷」——
 * 前者是回喂上下文的字符串，后者是 diff / 文件列表这类前端可渲染得更好的数据。
 * 0.1.0 无工具执行，本类型不产生（bridge 留 TODO）。
 */
export interface ToolResultData {
  readonly id: string;
  /** 成功 / 失败 */
  readonly ok: boolean;
  /** 给人看的结果摘要 */
  readonly summary: string;
  /** 回喂模型的文本（与 summary 视角不同，见 002 5.4 双表示） */
  readonly forModel?: string;
  /** 结构化载荷（如 diff），前端可渲染得更好 */
  readonly payload?: unknown;
}

/** 审批请求的风险级别（002 5.2 工具 risk 分类）。 */
export type RiskLevel = 'read' | 'write' | 'exec' | 'network';

/** 审批裁决的三种取值（与 3.3 `approve` 命令一一对应，全局唯一语义）。 */
export type ApprovalDecision = 'allow_once' | 'allow_always' | 'deny';

/** approval 可选项（与 3.3 `approve` 命令的三种裁决一一对应）。 */
export interface ApprovalOption {
  readonly id: ApprovalDecision;
  readonly label: string;
}

/**
 * approval_request：弹窗请求，前端回以 `approve` 命令。
 * 0.3.0 才真正发出；此处先定类型，作为 0.1.0 协议面的完整契约。
 */
export interface ApprovalRequestData {
  readonly id: string;
  readonly description: string;
  readonly risk: RiskLevel;
  readonly options: readonly ApprovalOption[];
}

/** approval_resolved：裁决与来源。0.1.0 不产生。 */
export interface ApprovalResolvedData {
  readonly id: string;
  readonly decision: ApprovalDecision;
  readonly source: 'user' | 'rule' | 'policy';
}

/** usage：token 分项、缓存命中。0.1.0 只报 token，`totalCost` 留待费用核算。 */
export interface UsageData {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly noCacheTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalCost?: number;
}

/** context_state 的分项条目。 */
export interface ContextSection {
  readonly name: string;
  readonly tokens: number;
}

/**
 * context_state 的预算偏差（粗估 vs 实测；协议自持一份，与 core 内部
 * TokenDrift 同形——前端据此判断字符级近似与供应商分词器的系统性偏离，
 * 002 7.3「偏差大说明分词器选错了」）。
 */
export interface ContextDrift {
  /** 累计粗估输入 token（请求前本地估算，仅含已校准的请求） */
  readonly estimated: number;
  /** 供应商校准的累计实测输入 token */
  readonly actual: number;
  /** 偏差 = estimated - actual（正 = 高估，负 = 低估） */
  readonly error: number;
  /** 相对偏差率 = error / actual（actual 为 0 时取 0） */
  readonly rate: number;
}

/** context_state：各分项占用、合计、预算偏差、压缩是否临近。0.6.0 才产出。 */
export interface ContextStateData {
  readonly nearCompaction: boolean;
  readonly sections: readonly ContextSection[];
  /** 各分项合计（估算输入 token；drift 由此与累计实测校准） */
  readonly total: number;
  /** 粗估 vs 实测偏差（budget 账本的 drift，见 ContextDrift） */
  readonly drift: ContextDrift;
}

/** compaction：压缩前后 token、被折叠的轮次范围。0.7.0（T-070 /compact）才产出。 */
export interface CompactionData {
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly coveredTurns: readonly [number, number];
}

/** notice 级别。 */
export type NoticeLevel = 'info' | 'warn' | 'error';

/** notice：提示区（配置告警、指令截断、降级提示…）。 */
export interface NoticeData {
  readonly level: NoticeLevel;
  readonly text: string;
}

/**
 * error：错误分类、是否可恢复、面向用户的说明。
 * `kind` 沿用 ProviderError 的细分（rate_limited / invalid_api_key / timeout…），
 * 前端按 `recoverable` 决定是否展示重试入口（T-014 的退避重试据此分类）。
 */
export interface ErrorData {
  readonly category: 'provider' | 'internal';
  readonly kind: string;
  readonly recoverable: boolean;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// 判别联合：type 与 data 一一对应
// ---------------------------------------------------------------------------

/** 全部协议事件（type + data 联动）。 */
export type ProtocolEvent =
  | { readonly type: 'turn_start'; readonly data: TurnStartData }
  | { readonly type: 'turn_end'; readonly data: TurnEndData }
  | { readonly type: 'text_delta'; readonly data: TextDeltaData }
  | { readonly type: 'thinking_delta'; readonly data: ThinkingDeltaData }
  | { readonly type: 'tool_call'; readonly data: ToolCallData }
  | { readonly type: 'tool_progress'; readonly data: ToolProgressData }
  | { readonly type: 'tool_result'; readonly data: ToolResultData }
  | { readonly type: 'approval_request'; readonly data: ApprovalRequestData }
  | { readonly type: 'approval_resolved'; readonly data: ApprovalResolvedData }
  | { readonly type: 'usage'; readonly data: UsageData }
  | { readonly type: 'context_state'; readonly data: ContextStateData }
  | { readonly type: 'compaction'; readonly data: CompactionData }
  | { readonly type: 'notice'; readonly data: NoticeData }
  | { readonly type: 'error'; readonly data: ErrorData };

// ---------------------------------------------------------------------------
// 信封（3.1）
// ---------------------------------------------------------------------------

/**
 * 信封：所有事件的共享外壳。
 * - `v`：协议版本，固定 1；
 * - `seq`：单调递增，前端据此排序与去重；
 * - `ts`：epoch ms；
 * - `agent`：发出者 ID，主代理固定 "main"（0.12.0 子代理带上自身 ID）；
 * - `turn`：所属轮次（前端据此跨轮次归拢）；
 * - `type` / `data`：事件类型与按类型判别的负载。
 *
 * 用「公共字段 & 事件」的交叉类型定义，使 `type` 与 `data` 在类型层面联动：
 * 消费方在 `if (envelope.type === 'text_delta')` 之后可直接访问
 * `envelope.data.delta`，无需二次断言。
 */
export type Envelope<TEvent extends ProtocolEvent = ProtocolEvent> = {
  readonly v: 1;
  readonly seq: number;
  readonly ts: number;
  readonly agent: string;
  readonly turn: number;
} & TEvent;
