import type {
  ModelMessage,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ToolSet,
} from 'ai';
import {
  isProviderError,
  normalizeProviderError,
  ProviderError,
} from '../provider/errors';
import type {
  ModelProvider,
  StreamFinishReason,
  TokenUsage,
} from '../provider/types';
import { computeCacheHitRate } from '../provider/vercel';
import type { ApprovalGate } from '../permission/approval';
import type { HookBus } from '../hooks/bus';
import type {
  ApprovalDecision,
  ApprovalOption,
  CompactionData,
  ContextStateData,
  NoticeLevel,
  RiskLevel,
} from '../protocol/events';
import { runToolPipeline } from '../tools/pipeline';
import { redactValue } from '../tools/redact';
import type { ToolRegistry } from '../tools/registry';
import type { SubagentRunner, WriteConflictReport } from '../tools/types';
import { toToolSet } from '../tools/toolset';
import { createSubagentRunner } from './subagent';
import { extractInterruptReason, isInterruptError } from './interrupt';
import { withRetry } from './retry';
import type { RetryOptions } from './retry';
import { BudgetLedger } from '../context/budget';
import { buildContextState, estimateContextSections } from '../context/project';
import {
  compactProjection,
  isCompactionNeeded,
  runCompaction,
  splitThreadIntoTurns,
  DEFAULT_KEEP_TURNS,
  DEFAULT_MIN_TURNS_BETWEEN_COMPACTIONS,
} from '../context/compact';
import type { CompactOptions } from '../context/compact';
import type { SummaryItem, SummaryState } from '../context/summary';
import { createSummaryState } from '../context/summary';
import type { TodoState } from '../context/todo';
import { applyTodoWrite, createTodoState } from '../context/todo';
import {
  canTransition,
  stopReasonToTransition,
  type LoopState,
  type LoopTransitionName,
} from './state';
import type { SessionLog } from '../session/log';

export interface TurnOptions {
  /** 轮次上限：允许发起的最大模型请求数，超限即终止并标记 halted */
  readonly maxTurns: number;
  /**
   * 预算上限（token）：累计 input + output 超过即终止（0.1.0 简化预算，
   * 只在每轮 usage 到达后检查；T-052 会替换为完整预算核算）。
   */
  readonly maxTokens?: number;
  /** 中断信号：透传给 provider；触发后本轮终止为 interrupted */
  readonly abortSignal?: AbortSignal;
  /**
   * 供应商错误的指数退避重试参数（T-014）。缺省用默认值（最多 3 次尝试）。
   * 重试发生在 provider 流内（单轮内），详见 retry.ts。
   */
  readonly retry?: RetryOptions;
}

export interface RunAgentTurnInput {
  readonly provider: ModelProvider;
  readonly system?: string;
  /** 对话消息（AI SDK ModelMessage 规范格式）。loop 只追加自己的副本，不改入参。 */
  readonly messages: ModelMessage[];
  /**
   * 工具注册表：提供时，streamChat 把注册表转成 AI SDK ToolSet 传给模型
   * （模型能看到工具定义、能发出 tool_use），tool_use 一律走执行管线
   * （runToolPipeline——管线对未注册工具产出 ok:false 且列出可用工具名）；
   * 未提供时模型看不到任何工具，仍收到 tool_use 则按「未知工具」回喂。
   */
  readonly tools?: ToolRegistry;
  /**
   * 会话级已读文件集合（绝对路径，Write/Edit 防盲写的生产者种子）：
   * 调用方/headless 传入会话既有的已读状态，或缺省新建（空集合）。
   * loop 会把它复制成内部可变集合并持续维护——Read 工具成功读到的文件
   * 经 ctx.onFileRead 回调实时入集，集合跨轮次持续（同一会话内 Read 过
   * 即可 Edit/Write 覆盖）；tools 拿到的始终是当前累计的只读快照。
   */
  readonly readFiles?: ReadonlySet<string>;
  /** 工作目录：传给工具 ctx.cwd（相对路径以此解析）。缺省 process.cwd()。 */
  readonly cwd?: string;
  /**
   * 审批闸门（T-033）：提供时，管线 ③ Authorize 对 write / exec 工具调用它
   * （发 approval_request 阻塞等裁决，deny → 策略性拒绝回喂）。read 不拦。
   * 缺省 = 管线不拦截（0.2.0 及之前行为）。headless 按策略装配并注入。
   */
  readonly approval?: ApprovalGate;
  /**
   * 会话日志（T-060）：提供时，本轮把 user 消息、assistant 回复、tool 调用与
   * 结果、usage、turn_start/end 追加进日志（旁路记录）。日志写失败由
   * SessionLog 自行经 onError 报告，不改变返回值 / 事件流语义；缺省不记录。
   */
  readonly session?: SessionLog;
  /**
   * 已入日志的 user 消息数（T-061 /resume 续写）：messages 中前
   * `loggedUserCount` 条 user 消息已在本会话日志中记录过（resume 重放的
   * 完整历史），loop 不再重复追加，只记录其后的新增 user 消息。
   * 缺省 0 = 所有 user 消息都记录（既有行为，旧调用不受影响）。
   */
  readonly loggedUserCount?: number;
  /**
   * 预算账本（T-062）：提供时，loop 把每次请求前的粗估与响应后的校准记入该
   * 账本（跨调用持续累计——TUI 每轮传入同一实例即得会话累计；/resume 可先用
   * `BudgetLedger.rebuild` 从会话 usage 条目重建后传入，实际分项接续历史）。
   * 缺省 loop 自建新账本，并随 `TurnResult.budget` 返回给调用方。
   */
  readonly budget?: BudgetLedger;
  /**
   * 持久摘要状态（T-070 /compact）：提供时，loop 把压缩后的状态随
   * `TurnResult.summaryState` 返回（调用方 / TUI 每轮传入同一演进状态即可
   * 跨轮次增量压缩；迟滞记账 turnCount / lastCompactedTurn 也随它接续）；
   * /resume 可先用 `rebuildSummaryState` 从会话日志的 compaction 条目重建后
   * 传入。缺省 = 本轮不进行任何压缩 / 折叠。
   */
  readonly summaryState?: SummaryState;
  /**
   * 会话级待办清单状态（T-110 TodoWrite）：提供时，模型调用 todo_write 更新
   * 的清单并入该状态，并随 `TurnResult.todoState` 返回（调用方跨轮次传入同一
   * 演进状态即可持续累计）；/resume 可先用 `rebuildTodoState` 从会话日志的
   * todo_update 条目重建后传入。缺省 = loop 在首次清单更新时自建（懒初始化），
   * 结果随 TurnResult.todoState 返回。清单与压缩状态共用条目结构（ADR 0010），
   * 压缩时清单不丢。
   */
  readonly todoState?: TodoState;
  /**
   * 压缩配置（T-070 /compact）：提供时，loop 在每轮请求前做「触发 → 压缩 →
   * 投影」：上下文估算超 `thresholdTokens`、轮数超 `keepTurns` 且迟滞窗口已过
   * （`minTurnsBetweenCompactions`，缺省 5 轮）时调用 `generateDelta`（可注入；
   * 生产由模型生成增量，测试注入 stub）产出 delta、增量合并进摘要状态、
   * 发出协议 `compaction` 事件并把压缩后的状态记入会话日志（提供 session 时）；
   * 随后把发给模型的请求投影为「摘要块 + 近 N 轮原文」（早期轮次用摘要占位，
   * 日志原文仍在）。迟滞记账随摘要状态持久化（turnCount / lastCompactedTurn），
   * 跨 runAgentTurn 接续，避免跨阈值后每轮重复压缩。缺省 = 不压缩不折叠。
   */
  readonly compact?: CompactOptions;
  /**
   * 子代理深度（T-120 一层深限制，ADR 0011）：主代理深度 0，子代理深度 1。
   * 深度 ≥ 1 的 loop 里 ToolContext.runSubagent 直接拒绝——子代理不能再派出
   * 子代理（supervisor 一层深，不做嵌套）。由 runtime/subagent.ts 派发时设置；
   * 调用方一般不用管（缺省 0）。
   */
  readonly subagentDepth?: number;
  /**
   * 本循环的 agent 标识（T-122 写冲突上报用）：主代理缺省 'main'；子代理由
   * 派发器传自身 ID（sub-xxx）。写冲突检测（onFileWrite）用它区分写入者。
   */
  readonly agentId?: string;
  /**
   * 写冲突检测钩子（T-123，ADR 0011）：每次工具成功写入一个文件后调用（path =
   * 工具上报的解析后绝对路径，agent = 写入者标识，见 agentId）。返回冲突报告
   * （同一文件此前已被另一 agent 写入）或 undefined；返回冲突时本 loop 发
   * notice（warn）告知前端。缺省 = 不检测（0.11.0 及之前行为）。调用方可注入
   * WriteConflictDetector（tools/write-conflict.ts 的 toOnFileWrite）。
   */
  readonly onFileWrite?: (
    path: string,
    agent: string,
  ) => WriteConflictReport | undefined;
  /**
   * 钩子总线（0.14.0，design 002 5.1 ④⑦ 挂载点）：提供时，管线 ④ PreToolUse
   * （deny 阻止执行且理由回喂模型 / 可改写参数）、⑦ PostToolUse（观察 /
   * 副作用，如编辑后自动 format）挂载钩子。子代理派发器继承同一总线（钩子是
   * 统一的管线安全面——子代理的工具调用同样过钩子）。缺省 = 管线直通
   * （0.13.0 及之前行为）。TUI 按 settings.json hooks 装配后注入。
   */
  readonly hooks?: HookBus;
  readonly options: TurnOptions;
}

export type TurnTermination = 'end_turn' | 'halted' | 'interrupted' | 'error';

/** 一次 `runAgentTurn` 的产出：汇总文本、累计用量、终止原因。 */
export interface TurnResult {
  /** 全部轮次产出的文本（含终止/打断前已产出的部分） */
  readonly text: string;
  /** 累计 token 用量（各分项缺失时保持 undefined） */
  readonly usage: TokenUsage;
  /**
   * 本次调用的预算账本（T-062）：含每次请求前的粗估、响应后的校准与累计漂移
   * （`TurnResult.budget.drift()`）。传入的 `RunAgentTurnInput.budget` 实例
   * 会原样返回——调用方跨轮次累计只需持有同一实例。
   */
  readonly budget: BudgetLedger;
  /**
   * 本轮结束后的持久摘要状态（T-070）：仅当入参提供了 `summaryState`（或本轮
   * 发生了压缩）时存在——调用方把它作为下一轮的种子传入，跨轮次增量压缩。
   * 缺省 undefined（未启用压缩）。
   */
  readonly summaryState?: SummaryState;
  /**
   * 本轮结束后的待办清单状态（T-110 TodoWrite）：模型调用过 todo_write 时
   * 存在（入参种子演进 / 首次更新自建）——调用方把它作为下一轮的种子传入。
   * 缺省 undefined（本轮未触碰清单）。
   */
  readonly todoState?: TodoState;
  /** 最后一轮的 finish reason（未收到 finish 事件时为 null） */
  readonly finishReason: StreamFinishReason | null;
  readonly termination: TurnTermination;
  /** 实际完成的轮次（模型请求数） */
  readonly turns: number;
  /** 终止时的状态机状态 */
  readonly state: LoopState;
  /**
   * 本轮结束时的会话级已读文件集合（0.12.1 修复）：loop 持续维护的 readFiles
   * 快照（跨轮次的已读累计，Write/Edit 防盲写的生产者种子）。子代理派发器据此
   * 把子代理本地已读集合的增量并入父集合（共享 Set 语义兑现——子代理 Read 过
   * 的文件主代理可直接 Edit/Write）。调用方若跨轮次自行持有 readFiles，需与
   * 本返回值合并（TUI 从会话日志重建，见 refreshHistory）。
   */
  readonly readFiles: ReadonlySet<string>;
  /** termination === 'error' 时的归一错误 */
  readonly error?: ProviderError;
  /** termination === 'interrupted' 时的中断原因（来自 abort signal） */
  readonly interruptedReason?: unknown;
}

/**
 * Runtime 内部事件流。T-013 把这里的每个事件映射为协议层信封
 * （turn_start / turn_end / text_delta / thinking_delta / tool_call / usage /
 * error / notice）。`tool_feedback` 是 runtime 层事件：仅在「未提供工具
 * 注册表」时标识「未知工具」错误已回喂模型（提供注册表时未知工具由管线
 * 产出 tool_result，见下）。`tool_result` 由工具管线（⑧ Record）的执行结果
 * 转换而来，携带与人看的 tool_result 协议事件一致的负载（id / ok / summary /
 * forModel / payload），bridge 直接映射为协议 tool_result。
 */
export type RuntimeEvent =
  | { readonly type: 'turn_start'; readonly turn: number }
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'thinking_delta'; readonly delta: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_feedback';
      readonly id: string;
      readonly name: string;
      readonly error: string;
    }
  | {
      readonly type: 'tool_result';
      readonly id: string;
      readonly ok: boolean;
      readonly summary: string;
      readonly forModel?: string;
      readonly payload?: unknown;
    }
  | {
      readonly type: 'approval_request';
      readonly id: string;
      readonly description: string;
      readonly risk: RiskLevel;
      readonly options: readonly ApprovalOption[];
    }
  | {
      readonly type: 'approval_resolved';
      readonly id: string;
      readonly decision: ApprovalDecision;
      readonly source: 'user' | 'rule' | 'policy';
    }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | {
      readonly type: 'context_state';
      readonly data: ContextStateData;
    }
  | {
      readonly type: 'compaction';
      readonly data: CompactionData;
    }
  | {
      readonly type: 'todo_update';
      readonly items: readonly SummaryItem[];
    }
  | {
      readonly type: 'notice';
      readonly level: NoticeLevel;
      readonly text: string;
    }
  | { readonly type: 'error'; readonly error: ProviderError }
  | {
      readonly type: 'turn_end';
      readonly turn: number;
      readonly termination: TurnTermination;
    }
  | {
      /**
       * 子代理内部运行时事件（T-122，0.12.0 子代理事件流）：子代理派发器把
       * 子代理 loop 的每个 RuntimeEvent 包上 agentId 转发。bridge 据此为每个
       * 子代理分配独立 EnvelopeEmitter（agent = 子代理 ID、独立 seq/turn 空间），
       * 前端按 agent 分组折叠——协议一个字节都不用改（002 3.1 的便宜先手）。
       * 一层深硬限制保证内层事件不再嵌套 subagent_event（子代理不能再派生子代理）。
       */
      readonly type: 'subagent_event';
      /** 子代理 ID（协议信封的 agent 字段）。 */
      readonly agent: string;
      /** 子代理内部事件。 */
      readonly event: RuntimeEvent;
    };

/** 未提供工具注册表时的回喂文案：模型看不到任何工具定义却发了工具调用。 */
const UNKNOWN_TOOL_MESSAGE = (name: string): string =>
  `未知工具 "${name}"：当前会话未提供工具注册表，无法执行任何工具调用。请勿调用工具，直接用文本回答用户。`;

/** 归一任意错误为 ProviderError（provider 适配层本应已归一，此处兜底）。 */
function toProviderError(error: unknown): ProviderError {
  return isProviderError(error) ? error : normalizeProviderError(error);
}

/**
 * 提取 AI SDK user 消息的文本：content 为 string 时原样取，为 parts 数组时
 * 拼接全部 text part（附件等非文本 part 不入日志正文）。
 */
function extractUserText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  const parts: string[] = [];
  for (const part of message.content) {
    if (part.type === 'text') parts.push(part.text);
  }
  return parts.join('\n');
}

/**
 * 粗估一次模型请求的输入 token（002 7.3 请求前本地粗估）：对将发内容估算
 * （system 提示词 + 消息正文 + 工具定义文本）。
 *
 * 直接复用 context/project.ts 的分项估算（`estimateContextSections().total`，
 * 即系统提示 + 工具定义 + 项目指令占位 + 历史 + 工具输出五段之和）——请求级
 * 粗估与 `/context` 分项视图**必须同源**，否则账本 drift 度量的是两套估算的
 * 差而不是「近似 vs 实测」的系统偏差。估算精度与取舍见 budget.ts「精度取舍」。
 */
function estimateRequestText(
  system: string | undefined,
  messages: readonly ModelMessage[],
  tools: ToolRegistry | undefined,
): number {
  return estimateContextSections({
    system: system ?? '',
    tools,
    thread: messages,
  }).total;
}

/**
 * Agent loop 内核（002 4.2 / 4.3）：`while(tool_use)` 裸循环。
 *
 * 主流程：
 * 1. idle → assemble → streaming，发起一次 `provider.streamChat`；
 * 2. 流中事件直接透出（text / thinking / tool_use / usage），
 *    文本累计进结果、usage 累计进账本；请求前本地粗估（T-062）在发起前
 *    入账、usage 到达后以供应商为准校准（BudgetLedger）；
 * 3. `stop_reason` 驱动流转（stopReasonToTransition）：
 *    - `tool_use` → executing：tools 提供时（注册与否）一律经 runToolPipeline
 *      执行并回喂，未注册工具由管线产出 ok:false + 可用工具列表；tools 未提供
 *      才保留「未知工具」错误回喂（见 feedBackToolRound）；
 *    - 其余 → end_turn 收尾回 idle；
 *    - `error` → 终止为 error。
 * 4. 上限兜底：轮次在 ASSEMBLE 检查、预算在每轮 usage 后检查，超限 → halted；
 *    中断经 abort signal 透传 provider，捕获 aborted 错误后转 interrupted，
 *    已产出的文本照常返回。
 *
 * Runtime 保持薄：只做编排，不做业务判断（判断在模型那边）。
 */
export async function runAgentTurn(
  input: RunAgentTurnInput,
  onEvent?: (event: RuntimeEvent) => void,
): Promise<TurnResult> {
  const {
    provider,
    system,
    messages,
    tools,
    options,
    readFiles: initialReadFiles,
    cwd: inputCwd,
    approval,
    session,
    loggedUserCount,
    budget: inputBudget,
    summaryState: inputSummaryState,
    compact: compactConfig,
  } = input;
  const { maxTurns, maxTokens, abortSignal } = options;
  const emit = onEvent ?? (() => {});

  /**
   * 预算账本（T-062）：调用方注入（/resume 重建后的实例）或缺省自建，
   * 全程累计——每次请求前粗估、响应后校准，随 TurnResult.budget 返回。
   */
  const ledger = inputBudget ?? new BudgetLedger();

  /**
   * 会话级已读文件集合（Write/Edit 防盲写的生产者）：
   * 从入参复制（或缺省新建），Read 工具成功读到的文件路径经 onFileRead
   * 回调实时加入；集合跨轮次持续——同一会话内 Read 过即可 Edit/Write 覆盖。
   */
  const readFiles = new Set<string>(initialReadFiles ?? []);
  /** 工作目录：入参提供或缺省 process.cwd()，传给工具 ctx.cwd。 */
  const cwd = inputCwd ?? process.cwd();
  /** 本循环的 agent 标识（写冲突上报用）：主代理 'main'，子代理自身 ID。 */
  const agent = input.agentId ?? 'main';

  /**
   * 子代理派发通道（T-120 Task 工具）：注入 ToolContext 的 runSubagent——
   * Task 工具 execute 经此派生子代理（独立 runAgentTurn / 独立消息历史 /
   * 独立上下文窗口），只拿回最终结论文本。一层深限制在此强制：深度 ≥ 1
   * （即子代理自身）的 loop 里派发直接拒绝（ADR 0011）；`task` 工具也永不
   * 进入子代理注册表（deriveSubagentRegistry 过滤），双保险。
   */
  const runSubagent: SubagentRunner = createSubagentRunner({
    runTurn: runAgentTurn,
    provider,
    parentRegistry: tools,
    readFiles,
    cwd,
    approval,
    abortSignal,
    depth: input.subagentDepth ?? 0,
    // T-122：子代理运行时事件包上 agentId 转出为 subagent_event
    emit,
    // T-123：写冲突检测——子代理写入按自身 agentId 上报（与主代理的 'main'
    // 区分，跨 agent 同文件写入被检出冲突）
    onFileWrite: input.onFileWrite,
    // T-142：钩子总线继承——子代理的工具调用同样过 ④⑦ 钩子（统一的管线安全面）
    hooks: input.hooks,
  });

  /**
   * 持久摘要状态（T-070）：从入参复制，压缩发生时在此演进，随
   * `TurnResult.summaryState` 返回给调用方（跨轮次增量压缩的种子）。
   * 提供 `compact` 配置而未提供状态时自动新建空状态（首轮压缩即产出内容）。
   */
  let summaryState: SummaryState | undefined =
    inputSummaryState ??
    (compactConfig === undefined ? undefined : createSummaryState());

  /**
   * 会话级待办清单状态（T-110 TodoWrite）：从入参复制（/resume 重建后的种子），
   * 模型调用 todo_write 时经 applyTodoWrite 演进，随 `TurnResult.todoState`
   * 返回给调用方。懒初始化：首次清单更新才自建（未启用清单的会话保持 undefined）。
   */
  let todoState: TodoState | undefined = input.todoState;

  let state: LoopState = 'idle';
  let termination: TurnTermination = 'end_turn';
  let turn = 0;
  let text = '';
  let usage: TokenUsage = {};
  let finishReason: StreamFinishReason | null = null;
  let error: ProviderError | undefined;
  let interruptedReason: unknown;
  /** 最近一轮产出的文本（跨循环存活，供末轮收尾补记 assistant 条目）。 */
  let roundText = '';
  /** 最近一轮是否已随 feedBackToolRound 记入日志（纯文本轮需在收尾补记）。 */
  let roundLogged = false;

  /** 追加写的消息线程。绝不修改调用方的 messages。 */
  const thread: ModelMessage[] = [...messages];

  /**
   * 最近一轮发给模型的请求消息（T-070 压缩投影后；context_state 收尾核算用）。
   * 未启用压缩时恒等于 thread；启用后反映「摘要块 + 近 N 轮原文」的实际请求。
   */
  let lastRequestMessages: ModelMessage[] = thread;

  // —— 会话日志旁路：把本轮入参里的新增 user 消息追加进日志（唯一真相）。
  // 0.6.0 会话每次新建，messages 通常为「本轮用户输入」单条（TUI 每轮传
  // `[{ role: 'user', content: text }]`）；/resume（T-061）续写时调用方传入
  // 完整历史 + 新增段，并置 loggedUserCount = 历史里的 user 消息条数——
  // loop 跳过已入日志的前 N 条，只记录新增段，避免历史重复落盘。
  if (session !== undefined) {
    let userSeen = 0;
    for (const message of messages) {
      if (message.role === 'user') {
        if (userSeen >= (loggedUserCount ?? 0)) {
          await session.appendUser(extractUserText(message));
        }
        userSeen += 1;
      }
    }
  }

  /** 状态机迁移守卫：非法迁移是不变量破坏，正常路径不会触发。 */
  const move = (transition: LoopTransitionName): LoopState => {
    const next = canTransition(state, transition);
    if (next === null) {
      throw new Error(`非法状态迁移：${state} --${transition}--> ?`);
    }
    state = next;
    return next;
  };

  const accumulateUsage = (partial: TokenUsage): void => {
    const plus = (
      a: number | undefined,
      b: number | undefined,
    ): number | undefined =>
      a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    const cacheReadTokens = plus(
      usage.cacheReadTokens,
      partial.cacheReadTokens,
    );
    const noCacheTokens = plus(usage.noCacheTokens, partial.noCacheTokens);
    // 累计命中率（T-071）：以累计 cacheRead/noCache 计算（跨多轮工具循环的
    // 汇总口径，而非单轮比例的简单平均）；供应商未上报缓存分项时为 undefined。
    const cacheHitRate = computeCacheHitRate(cacheReadTokens, noCacheTokens);
    usage = {
      inputTokens: plus(usage.inputTokens, partial.inputTokens),
      outputTokens: plus(usage.outputTokens, partial.outputTokens),
      noCacheTokens,
      cacheReadTokens,
      cacheWriteTokens: plus(usage.cacheWriteTokens, partial.cacheWriteTokens),
      ...(cacheHitRate === undefined ? {} : { cacheHitRate }),
    };
  };

  const budgetExceeded = (): boolean => {
    if (maxTokens === undefined) return false;
    return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) > maxTokens;
  };

  /**
   * 回喂一轮的工具结果（assistant tool-call → tool 结果，AI SDK ModelMessage
   * 规范格式，与 0.1.0 验证过的构造方式一致）：提供工具注册表时，tool_use
   * 一律经 runToolPipeline 执行（注册与否都由管线归一——未注册工具产出
   * ok:false 且列出可用工具名）；未提供注册表才按「未知工具」错误回喂。
   * 管线发出的协议事件在此转成 RuntimeEvent 透出（tool_call 跳过，见
   * executeToolCall 内注释）。
   */
  const feedBackToolRound = async (
    roundText: string,
    toolUses: ReadonlyArray<{ id: string; name: string; input: unknown }>,
    tools: ToolRegistry | undefined,
  ): Promise<void> => {
    const assistantContent: Array<TextPart | ToolCallPart> = [];
    if (roundText.length > 0) {
      assistantContent.push({ type: 'text', text: roundText });
    }
    for (const call of toolUses) {
      assistantContent.push({
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
      });
    }
    thread.push({ role: 'assistant', content: assistantContent });
    roundLogged = true;
    if (session !== undefined) {
      // assistant 条目：本轮文本 + 工具调用（入参脱敏后再入日志——不能让
      // 密钥落到磁盘上的会话文件里，002 5.4「脱敏发生在入日志之前」）。
      await session.appendAssistant({
        text: roundText,
        ...(toolUses.length > 0
          ? {
              calls: toolUses.map((call) => ({
                id: call.id,
                name: call.name,
                input: redactValue(call.input),
              })),
            }
          : {}),
      });
    }

    const results: ToolResultPart[] = [];
    // 并行执行组（T-123 子代理）：concurrent 工具（如 task——子代理默认只读、
    // 互不共享文件写状态，ADR 0011）同一轮被多次调用时并行派发（Promise.all），
    // 结果按调用顺序聚合；其余工具保持串行（002 十一「工具默认串行落地」，
    // 并发写同一文件必然丢改动，换取可预测性）。
    const parallel: Array<{ index: number; promise: Promise<ToolResultPart> }> =
      [];
    for (let i = 0; i < toolUses.length; i += 1) {
      const call = toolUses[i];
      if (tools === undefined) {
        // 未提供注册表：模型看不到任何工具定义却发了 tool_use，
        // 保留「未知工具」错误回喂（含 tool_feedback 事件）
        emit({
          type: 'tool_feedback',
          id: call.id,
          name: call.name,
          error: UNKNOWN_TOOL_MESSAGE(call.name),
        });
        results[i] = {
          type: 'tool-result',
          toolCallId: call.id,
          toolName: call.name,
          output: {
            type: 'error-text',
            value: UNKNOWN_TOOL_MESSAGE(call.name),
          },
        };
      } else {
        // 提供注册表（无论该工具是否注册）：一律走管线。未注册工具由
        // 管线产出 ok:false + 可用工具列表，比 loop 自己的弱诊断更可诊断。
        const tool = tools.find(call.name);
        if (tool?.concurrent === true) {
          parallel.push({ index: i, promise: executeToolCall(call, tools) });
        } else {
          results[i] = await executeToolCall(call, tools);
        }
      }
    }
    for (const { index, promise } of parallel) {
      results[index] = await promise;
    }
    thread.push({ role: 'tool', content: results });
  };

  /**
   * 通过工具管线执行一次工具调用，返回 AI SDK 的 tool-result 消息片段。
   *
   * 管线 ⑧ Record 的协议事件在此转成 RuntimeEvent：
   * - `tool_call` 跳过——流式阶段已由 `tool_use` 事件经 bridge 映射为协议
   *   tool_call（入参已在透出时脱敏，见上方 tool_use 分支），再转发会同一
   *   调用出现两条 tool_call；
   * - `tool_result` 转成 RuntimeEvent，由 bridge 映射为协议 tool_result
   *   （summarizer / 双表示字段原样保留）。
   *
   * 管线不抛 ProviderError：中断 / 超时 / 执行错误一律归一为 `ok:false`
   * 的 ToolOutcome 回喂模型自纠；turn 级中断语义由 abortSignal 透传保证——
   * 中止信号已置位时，管线中断工具、下一轮 provider 请求立即以 aborted
   * 失败，loop 照常转 interrupted。
   */
  const executeToolCall = async (
    call: { id: string; name: string; input: unknown },
    tools: ToolRegistry,
  ): Promise<ToolResultPart> => {
    const outcome = await runToolPipeline(
      { id: call.id, name: call.name, input: call.input },
      {
        registry: tools,
        abortSignal,
        // ③ Authorize（T-033）：write / exec 工具经审批闸门（read 不拦）。
        // 缺省不拦截（调用方未注入时保持 0.2.0 行为）。
        // ④ PreToolUse / ⑦ PostToolUse（0.14.0）：注入钩子总线时挂载——
        // deny 阻止执行（理由回喂模型）/ 改写参数 / 观察副作用。
        authorize: approval,
        hooks: input.hooks,
        // 执行上下文：cwd 供相对路径解析；readFiles 供 Write/Edit 防盲写检查；
        // onFileRead 是已读集合的唯一生产者——read 工具成功读到一个文件后
        // 回调，loop 据此把该文件（realpath 已由 read 工具解析）加入会话集合，
        // 使同轮或后续轮次的 Write/Edit 放行。集合跨轮次持续。
        // sessionId 是钩子输入契约的一部分（0.14.0）。
        context: {
          cwd,
          ...(session !== undefined ? { sessionId: session.sessionId } : {}),
          readFiles,
          runSubagent,
          // T-123 写冲突检测：write/edit 成功落盘后自报路径，按本循环 agent
          // 上报（主代理 'main' / 子代理 ID）；检出跨 agent 同文件写入时发
          // notice（warn）告知前端「改动可能互相覆盖」（ADR 0011）。
          onFileWrite: (path) => {
            const conflict = input.onFileWrite?.(path, agent);
            if (conflict !== undefined) {
              emit({
                type: 'notice',
                level: 'warn',
                text:
                  `写冲突：文件 "${conflict.path}" 已被 ${conflict.existingAgent} 写入，` +
                  `现在由 ${conflict.agent} 再次写入——改动可能互相覆盖，请核对后决定取舍`,
              });
            }
          },
          onFileRead: (path) => {
            readFiles.add(path);
          },
          // T-110 TodoWrite：清单更新的唯一落点——演进会话级待办状态、
          // 发出 todo_update 运行时事件（bridge → 协议 todo_update，前端渲染）、
          // 落 todo_update 日志条目（/resume 重建依据）。
          onTodoUpdate: (update) => {
            if (todoState === undefined) todoState = createTodoState();
            todoState = applyTodoWrite(todoState, update.items);
            emit({ type: 'todo_update', items: update.items });
            void session?.appendTodoUpdate({ items: update.items });
          },
        },
        emit: (pipelineEvent) => {
          if (pipelineEvent.type === 'tool_result') {
            const { id, ok, summary, forModel, payload } = pipelineEvent.data;
            emit({
              type: 'tool_result',
              id,
              ok,
              summary,
              ...(forModel !== undefined ? { forModel } : {}),
              ...(payload !== undefined ? { payload } : {}),
            });
          } else if (pipelineEvent.type === 'approval_request') {
            // 审批请求事件：bridge 据此映射为协议 approval_request（弹窗等裁决）
            const { id, description, risk, options } = pipelineEvent.data;
            emit({
              type: 'approval_request',
              id,
              description,
              risk,
              options,
            });
          } else if (pipelineEvent.type === 'approval_resolved') {
            // 审批裁决收尾：bridge 据此映射为协议 approval_resolved（关闭弹窗）
            const { id, decision, source } = pipelineEvent.data;
            emit({ type: 'approval_resolved', id, decision, source });
          } else if (pipelineEvent.type === 'notice') {
            // 管线侧提示（0.14.0：PreToolUse 钩子改写参数时补发的说明性
            // notice）——bridge 映射为协议 notice，前端提示区展示（不静默）。
            const { level, text } = pipelineEvent.data;
            emit({ type: 'notice', level, text });
          }
        },
      },
    );
    if (session !== undefined) {
      // tool_result 条目：一次工具执行的结果（forModel 回喂模型 / payload 给人）。
      await session.appendToolResult({
        callId: call.id,
        ok: outcome.ok,
        forModel: outcome.forModel,
        ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
        ...(outcome.payload !== undefined ? { payload: outcome.payload } : {}),
      });
    }
    return {
      type: 'tool-result',
      toolCallId: call.id,
      toolName: call.name,
      output: outcome.ok
        ? { type: 'text', value: outcome.forModel }
        : { type: 'error-text', value: outcome.forModel },
    };
  };

  const finalize = async (): Promise<TurnResult> => {
    const result: TurnResult = {
      text,
      usage,
      budget: ledger,
      ...(summaryState !== undefined ? { summaryState } : {}),
      ...(todoState !== undefined ? { todoState } : {}),
      finishReason,
      termination,
      turns: turn,
      state,
      // 已读集合快照（0.12.1 修复）：随 TurnResult 带出——子代理派发器据此把
      // 子代理本地已读集合的增量并入父集合（共享 Set 语义兑现）。
      readFiles,
      ...(error !== undefined ? { error } : {}),
      ...(termination === 'interrupted' && interruptedReason !== undefined
        ? { interruptedReason }
        : {}),
    };
    // context_state（T-063）：本轮收尾时的上下文分项核算——系统提示 / 工具定义 /
    // 项目指令占位 / 历史 / 工具输出各段 token + 合计 + 预算 drift。前端 `/context`
    // 视图可直接消费（也即调试仪器：预算超支一眼看出哪段在膨胀，002 7.1）。
    // 在 turn_end 之前发出，信封轮次沿用当前轮（EnvelopeEmitter 由 turn_start
    // 推进；最终轮之后 turn_end 不再改变轮次值）。
    emit({
      type: 'context_state',
      data: buildContextState({
        system: system ?? '',
        tools,
        // T-070：以最近一轮发给模型的投影为准（压缩后 = 摘要块 + 近 N 轮原文），
        // 让 /context 分项视图反映真实请求，而非全量历史。
        thread: lastRequestMessages,
        budget: ledger,
      }),
    });
    emit({ type: 'turn_end', turn, termination });
    if (session !== undefined) {
      // 末轮若未随 feedBackToolRound 记入（纯文本轮 / 中断 / 错误的部分回复），
      // 收尾补记 assistant 文本——002 4.4：已产出的文本照常入日志，不残留。
      if (roundLogged === false && roundText.length > 0) {
        await session.appendAssistant({ text: roundText });
      }
      // 终止为 error 时补记 error 条目（可诊断的审计记录）。
      if (error !== undefined) {
        await session.appendError({
          category: error.category,
          kind: error.kind,
          recoverable: error.retryable,
          message: error.message,
        });
      }
      await session.appendTurnEnd(turn, termination);
    }
    return result;
  };

  // 工具注册表 → AI SDK v7 ToolSet：模型能看到工具定义、能发出 tool_use 的
  // 关键一环（G-0.2.0）。注册表缺失时不传（模型没有工具可用）。
  const toolSet: ToolSet | undefined =
    tools === undefined ? undefined : toToolSet(tools);

  // —— 状态机入口：idle --submit--> assemble ——
  move('submit');

  for (;;) {
    // —— ASSEMBLE：轮次上限检查（预算检查在每轮 usage 后即时做，见下）——
    if (turn >= maxTurns) {
      move('limits_exceeded'); // assemble → halted
      termination = 'halted';
      break;
    }

    turn += 1;
    emit({ type: 'turn_start', turn });
    await session?.appendTurnStart(turn);
    roundText = '';
    roundLogged = false;

    // —— 压缩迟滞记账（T-070）：会话内轮次计数单调递增（跨 runAgentTurn 接续，
    // 随 summaryState 持久化），供「压缩后 K 轮内不再触发」判定。只启用压缩时
    // 记账；summaryState 从入参复制为内部可变实例，此处用展开产生新对象。
    if (compactConfig !== undefined && summaryState !== undefined) {
      summaryState = {
        ...summaryState,
        turnCount: (summaryState.turnCount ?? 0) + 1,
      };
    }

    // assemble --request_started--> streaming
    move('request_started');

    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
    let roundError: ProviderError | undefined;
    let aborted = false;

    // —— 压缩触发 + 投影（T-070 /compact）——
    // 触发条件（全部满足才压缩）：上下文估算超阈值、轮数超 keepTurns、且
    // 迟滞窗口已过（turnCount - lastCompactedTurn >= minTurnsBetweenCompactions，
    // 缺省 5 轮——避免跨阈值后每轮重复压缩）。触发时调注入的摘要生成函数产出
    // delta、增量合并进持久摘要（merge，rev+1）、回写 lastCompactedTurn、
    // 发协议 compaction 事件、把压缩后的状态快照记入会话日志（/resume 重建
    // 依据）。日志原文仍在——压缩只影响投影，不删日志（002 4.1）。
    // 投影：早期轮次 → 摘要块，近 N 轮原文保留（含当前输入轮）；只影响发给
    // 模型的请求，内部 thread 与日志不动。
    let requestMessages: ModelMessage[] = thread;
    if (compactConfig !== undefined && summaryState !== undefined) {
      const keepTurns = compactConfig.keepTurns ?? DEFAULT_KEEP_TURNS;
      const minBetween =
        compactConfig.minTurnsBetweenCompactions ??
        DEFAULT_MIN_TURNS_BETWEEN_COMPACTIONS;
      const lastCompacted = summaryState.lastCompactedTurn ?? -Infinity;
      const sinceLast = (summaryState.turnCount ?? 0) - lastCompacted;
      if (
        isCompactionNeeded(thread, compactConfig.thresholdTokens) &&
        splitThreadIntoTurns(thread).length > keepTurns &&
        sinceLast >= minBetween
      ) {
        if (compactConfig.generateDelta === undefined) {
          emit({
            type: 'notice',
            level: 'warn',
            text: '上下文超压缩阈值但未注入摘要生成函数（compact.generateDelta），本轮跳过压缩',
          });
        } else {
          try {
            const outcome = await runCompaction(
              thread,
              summaryState,
              compactConfig,
            );
            summaryState = {
              ...outcome.state,
              lastCompactedTurn: summaryState.turnCount ?? 0,
            };
            emit({ type: 'compaction', data: outcome.event });
            await session?.appendCompaction({
              covers: outcome.event.coveredTurns,
              summaryRev: outcome.state.rev,
              state: summaryState,
            });
          } catch (caught) {
            emit({
              type: 'notice',
              level: 'warn',
              text: `压缩失败（${caught instanceof Error ? caught.message : String(caught)}），继续按既有摘要折叠投影`,
            });
          }
        }
      }
      requestMessages = compactProjection(thread, summaryState, compactConfig);
    }
    lastRequestMessages = requestMessages;

    // —— 请求前粗估（002 7.3）：对将发内容估算（system + 消息正文 + 工具定义），
    // 入账挂起待校准；本轮未产生 usage 时在下方收尾处丢弃（见 roundUsageArrived）。
    // T-070：以压缩投影后的请求为准（发给模型的正文才是真实计费口径）。
    ledger.recordEstimate(estimateRequestText(system, requestMessages, tools));
    // 本轮是否收到 usage 事件：没有则说明请求失败 / 供应商未上报，粗估不得
    // 参与配对——没有实际用量与之比较，计入漂移会让偏差失真。
    let roundUsageArrived = false;

    try {
      // 供应商错误（429 / 5xx / 超时）由 withRetry 按指数退避重试：
      // 只有尚未产出事件的失败才整体重试，已产出部分内容则直接按错误
      // 终止（保留已产文本）；退避期间 abort 也能立刻停下（干净中断）。
      const stream = withRetry(
        () =>
          provider.streamChat({
            system,
            messages: requestMessages,
            // 工具定义随请求发给模型：真实模型据此发出 tool_use（G-0.2.0）。
            // 注册表缺失时不传（模型没有工具可用）。
            ...(toolSet === undefined ? {} : { tools: toolSet }),
            abortSignal,
          }),
        {
          ...options.retry,
          abortSignal: abortSignal ?? options.retry?.abortSignal,
        },
      );
      for await (const event of stream) {
        switch (event.type) {
          case 'text_delta':
            roundText += event.delta;
            text += event.delta;
            emit({ type: 'text_delta', delta: event.delta });
            break;
          case 'thinking_delta':
            emit({ type: 'thinking_delta', delta: event.delta });
            break;
          case 'tool_use':
            toolUses.push({
              id: event.id,
              name: event.name,
              input: event.input,
            });
            // 转发为协议 tool_call 前先脱敏入参（与管线 ⑧ Record 的脱敏语义
            // 一致），避免模型入参里的密钥原样透出到事件流 / 会话日志。
            emit({
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: redactValue(event.input),
            });
            break;
          case 'usage':
            accumulateUsage(event.usage);
            // 预算校准（T-062）：供应商 usage 为准，与请求前粗估配对入账。
            ledger.recordUsage(event.usage);
            roundUsageArrived = true;
            emit({ type: 'usage', usage: event.usage });
            await session?.appendUsage(event.usage);
            break;
          case 'finish':
            finishReason = event.reason;
            break;
        }
      }
    } catch (caught) {
      const providerError = toProviderError(caught);
      if (isInterruptError(providerError)) {
        aborted = true;
        interruptedReason = extractInterruptReason(abortSignal, providerError);
      } else {
        roundError = providerError;
      }
    }

    // —— 本轮粗估校准兜底：未产生 usage 的轮次（中断 / 错误 / 供应商未上报），
    // 丢弃本轮待校准的粗估——请求从未真正消耗，不该计入累计漂移。已产生
    // usage 时队列已配对出队，forgetEstimate 幂等无操作。
    if (!roundUsageArrived) ledger.forgetEstimate();

    // —— 中断：streaming --interrupt--> interrupted ——
    if (aborted) {
      move('interrupt');
      termination = 'interrupted';
      break;
    }

    // —— 供应商错误：streaming --error--> halted ——
    if (roundError !== undefined) {
      error = roundError;
      move('error');
      termination = 'error';
      emit({ type: 'error', error });
      break;
    }

    // —— 预算上限（0.1.0 简化）：本轮 usage 已累计，超限即终止 ——
    if (budgetExceeded()) {
      move('limits_exceeded'); // streaming → halted
      termination = 'halted';
      break;
    }

    // —— stop_reason 直接驱动流转 ——
    if (finishReason !== null) {
      const mapped = stopReasonToTransition(finishReason);

      if (mapped.transition === 'tool_use') {
        if (toolUses.length === 0) {
          // 防御：理论上不会出现「reason=tool_use 却无 tool_use 事件」；
          // 按 end_turn 收尾，避免死循环。
          move('end_turn'); // streaming → idle
          break;
        }
        // streaming --tool_use--> executing：tools 提供时一律走执行管线
        // （未注册工具由管线产出 ok:false + 可用工具列表）；未提供注册表
        // 保留「未知工具」回喂（见 feedBackToolRound）
        move('tool_use');
        await feedBackToolRound(roundText, toolUses, tools);
        move('tool_result_logged'); // executing → assemble
        continue;
      }

      if (mapped.transition === 'error') {
        error = new ProviderError({
          kind: 'unknown',
          message: '模型流以 error 收尾（content-filter 或供应商内部错误）',
        });
        move('error'); // streaming → halted
        termination = 'error';
        emit({ type: 'error', error });
        break;
      }
    }

    // end_turn（stop / length / content-filter / other，或未收到 finish）
    move('end_turn'); // streaming → idle
    break;
  }

  return finalize();
}
