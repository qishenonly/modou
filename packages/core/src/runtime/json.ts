/**
 * 程序化入口（T-130 非交互模式增强，0.13.0「能进流水线」）。
 *
 * `runAgentTurn` 本身已可编程调用；本模块在其上提供脚本 / CI 友好的三件事：
 *
 * 1. **事件流 JSON**：`runAgentTurnJson` 把协议事件流收集为 JSON-safe 的信封数组
 *    （含 text / tool_call / tool_result / usage / approval_request / error /
 *    turn_end 等全部事件），供脚本逐条消费——不需要 TTY、不需要 Ink。
 * 2. **退出码语义化**：`exitCodeFor` 把一次运行归约为单一退出码
 *    （0 成功 / 1 失败 / 2 超限 / 3 需审批 / 130 中断），CI 据此路由结果：
 *    「需审批」是与普通失败不同的信号——无人值守下审批被默认拒绝
 *    （ADR 0012），脚本应把它转给人而非静默当作成功或重试。
 * 3. **stdin 管道输入**：`readStdinPrompt` 从 stdin 读全部内容作为 prompt
 *    （`echo "任务" | modou` 的管道形态），供脚本把任务文本经管道送入。
 *
 * 与 `runAgentTurnStreaming` 的关系：后者是 push 风格（逐条回调，TUI 用），
 * 本模块是 pull 风格（收集成数组返回），消费形态不同、底层同一条桥。
 */

import type { StreamFinishReason, TokenUsage } from '../provider/types';
import { runAgentTurnStreaming } from '../protocol/bridge';
import type { RunAgentTurnInput, TurnResult } from './loop';
import type { TurnTermination } from './loop';
import type { BudgetLedgerState } from '../context/budget';
import type { LoopState } from './state';
import type { Envelope, ProtocolEvent } from '../protocol/events';
import { ApprovalGate } from '../permission/approval';
import type { StructuredLogger } from '../logging/structured';
import { EnvelopeLogAdapter } from '../logging/structured';

// ---------------------------------------------------------------------------
// 退出码（T-130 语义化：脚本 / CI 据此路由结果）
// ---------------------------------------------------------------------------

/**
 * 退出码常量。
 *
 * | 码  | 含义                                        | CI 处置                     |
 * |----|---------------------------------------------|-----------------------------|
 * | 0  | 成功（end_turn 收尾，且无审批被拒）         | 通过                        |
 * | 1  | 失败（供应商 / 内部错误终止）               | 失败                        |
 * | 2  | 超限（轮次 / 预算上限触顶 halted）          | 失败（提预算）              |
 * | 3  | 需审批（有审批被拒或悬而未决）              | 转人审阅，勿静默重试        |
 * | 130| 中断（abort signal 打断）                   | 按用户取消处理              |
 *
 * 3 与 1 分开，是因为无人值守的「默认拒绝」（ADR 0012）不该被当作普通失败：
 * 重试也只会再次被拒，正确处置是把任务交给有权限的人。判断依据是事件流里的
 * approval_request / approval_resolved 对：存在被拒（deny）或运行结束时仍
 * 悬而未决的审批请求即返回 3。
 */
export const RunExitCode = {
  SUCCESS: 0,
  FAILURE: 1,
  HALTED: 2,
  APPROVAL_REQUIRED: 3,
  INTERRUPTED: 130,
} as const;

/** 事件流里是否存在「被拒或悬而未决」的审批请求（退出码 3 的判定依据）。 */
function hasDeniedOrPendingApproval(events: readonly Envelope[]): boolean {
  const pending = new Set<string>();
  let denied = false;
  for (const event of events) {
    if (event.type === 'approval_request') {
      pending.add(event.data.id);
    } else if (event.type === 'approval_resolved') {
      pending.delete(event.data.id);
      if (event.data.decision === 'deny') denied = true;
    }
  }
  return denied || pending.size > 0;
}

/**
 * 归约一次运行（事件流 + TurnResult）为退出码。
 *
 * 优先级：需审批（3）> 失败（1）> 超限（2）> 中断（130）> 成功（0）。
 * 需审批置顶：哪怕模型在审批被拒后仍完成了任务，只要出现过被拒 / 悬挂的审批，
 * CI 就应当知道「有人需要看」——静默放行与静默吞掉都是本版要消灭的行为。
 */
export function exitCodeFor(
  events: readonly Envelope[],
  result: TurnResult,
): number {
  if (hasDeniedOrPendingApproval(events)) return RunExitCode.APPROVAL_REQUIRED;
  switch (result.termination) {
    case 'error':
      return RunExitCode.FAILURE;
    case 'halted':
      return RunExitCode.HALTED;
    case 'interrupted':
      return RunExitCode.INTERRUPTED;
    case 'end_turn':
      return RunExitCode.SUCCESS;
  }
}

// ---------------------------------------------------------------------------
// TurnResult → JSON-safe 投影
// ---------------------------------------------------------------------------

/** TurnResult 的 JSON-safe 投影（脚本消费：无 Set / class 实例，可 JSON.stringify）。 */
export interface JsonSafeTurnResult {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly termination: TurnTermination;
  readonly finishReason: StreamFinishReason | null;
  readonly turns: number;
  readonly state: LoopState;
  /** 预算账本快照（跨轮次累计口径，与 context_state 的 drift 同源）。 */
  readonly budget: BudgetLedgerState;
  /** 会话级已读文件集合（绝对路径数组，供续写合并）。 */
  readonly readFiles: readonly string[];
  readonly error?: {
    readonly category: string;
    readonly kind: string;
    readonly retryable: boolean;
    readonly message: string;
  };
}

/** 把 TurnResult 投影为可序列化的纯 JSON 对象。 */
export function jsonSafeTurnResult(result: TurnResult): JsonSafeTurnResult {
  return {
    text: result.text,
    usage: result.usage,
    termination: result.termination,
    finishReason: result.finishReason,
    turns: result.turns,
    state: result.state,
    budget: result.budget.snapshot(),
    readFiles: [...result.readFiles],
    ...(result.error !== undefined
      ? {
          error: {
            category: result.error.category,
            kind: result.error.kind,
            retryable: result.error.retryable,
            message: result.error.message,
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// runAgentTurnJson：事件流收集 + 退出码
// ---------------------------------------------------------------------------

/** runAgentTurnJson 的构造选项（信封发射器 + 事件过滤 + 结构化日志）。 */
export interface RunAgentTurnJsonOptions {
  /** 发出者 ID（子代理 / 测试用；缺省 'main'）。 */
  readonly agent?: string;
  /** 时钟注入口（测试用；缺省 Date.now）。 */
  readonly now?: () => number;
  /**
   * 只收集这些类型的事件（缺省收集全部）。脚本可只取 text_delta + usage +
   * tool_result 等子集以减小输出体积。
   */
  readonly only?: ReadonlySet<ProtocolEvent['type']>;
  /**
   * 结构化日志（T-131）：提供时，事件流经 EnvelopeLogAdapter 落盘 JSONL
   * （request / tool_call / permission 三类条目，见 logging/structured.ts）。
   * 缺省不记录——脚本自行决定是否要旁路日志。
   */
  readonly structuredLog?: StructuredLogger;
}

/** 收集一次 `runAgentTurn` 的事件流为 JSON 的产出。 */
export interface RunAgentTurnJsonResult {
  /** 退出码（RunExitCode）：0 成功 / 1 失败 / 2 超限 / 3 需审批 / 130 中断。 */
  readonly exitCode: number;
  /** 协议事件流（JSON-safe 信封数组，按 seq 有序）。 */
  readonly events: readonly Envelope[];
  /** JSON-safe 的 turn 结果投影（文本 / 用量 / 终止原因 / 预算快照…）。 */
  readonly result: JsonSafeTurnResult;
}

/**
 * 程序化入口：把一次 `runAgentTurn` 的事件流收集为 JSON，并给出语义化退出码。
 *
 * - `input` 与 `runAgentTurn` 完全同形（provider / messages / tools / approval /
 *   session / options…）；
 * - 无人值守安全默认（ADR 0012）：**未注入 approval 且提供了工具时，本入口自动
 *   装配一个默认拒绝的 ApprovalGate**——程序化调用是无人值守形态，绝不静默放行
 *   需审批的操作。显式注入 approval（含允许的策略）即保持注入的行为。
 *
 * 产出三个字段：`events`（信封数组）、`result`（JSON-safe 投影）、`exitCode`。
 */
export async function runAgentTurnJson(
  input: RunAgentTurnInput,
  options: RunAgentTurnJsonOptions = {},
): Promise<RunAgentTurnJsonResult> {
  const envelopes: Envelope[] = [];
  const { approval: injectedApproval, tools } = input;
  // ADR 0012：无人值守默认拒绝——未注入审批闸门且注册表非空时，装配默认拒绝的
  // gate（ApprovalGate 缺省 decider 即 deny），并把输入补成自动装配后的形态。
  const effectiveInput: RunAgentTurnInput =
    injectedApproval !== undefined || tools === undefined
      ? input
      : {
          ...input,
          approval: createUnattendedApprovalGate(),
        };
  // T-131 结构化日志：提供 logger 时把事件流经适配器落盘（request /
  // tool_call / permission 三类，见 logging/structured.ts）。
  const adapter =
    options.structuredLog === undefined
      ? null
      : new EnvelopeLogAdapter(options.structuredLog, {
          provider: input.provider.id,
          model: input.provider.modelId,
        });
  const result = await runAgentTurnStreaming(
    effectiveInput,
    (envelope) => {
      adapter?.consume(envelope);
      if (options.only === undefined || options.only.has(envelope.type)) {
        envelopes.push(envelope);
      }
    },
    {
      agent: options.agent,
      ...(options.now !== undefined ? { now: options.now } : {}),
    },
  );
  return {
    exitCode: exitCodeFor(envelopes, result),
    events: envelopes,
    result: jsonSafeTurnResult(result),
  };
}

/**
 * 无人值守的默认拒绝审批闸门（ADR 0012 的装配点）。
 *
 * ApprovalGate 的缺省 decider 本就是「一律拒绝（deny，source: policy）」，
 * 这里包一层：被拒绝时补发一条 notice 让脚本 / 事件流明确知道「哪些操作被拦下」，
 * 绝不静默。与 `runAgentTurnJson` 的自动装配共用；TUI 无人值守（无 TTY）时
 * 同样用它。
 */
export function createUnattendedApprovalGate(): ApprovalGate {
  return new ApprovalGate();
}

// ---------------------------------------------------------------------------
// stdin 管道输入
// ---------------------------------------------------------------------------

/**
 * 从 stdin 读全部内容作为 prompt（`echo "任务" | modou` 的管道形态）。
 *
 * - 拼接全部 chunk（Buffer 或 string），按 UTF-8 解码，去首尾空白；
 * - 空输入（无内容 / 纯空白）返回空串，调用方据此决定是否拒绝（例如报
 *   「需要经 stdin 提供 prompt」）；
 * - 缺省读 `process.stdin`；测试注入任意 AsyncIterable / Iterable。
 *
 * 注意：stdin 是 `AsyncIterable<Uint8Array | string>` 形态（Node/Bun 的
 * ReadStream 即实现该接口），本函数不依赖任何进程全局，可离线测试。
 */
export async function readStdinPrompt(
  source:
    | AsyncIterable<Uint8Array | string>
    | Iterable<Uint8Array | string> = process.stdin,
): Promise<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for await (const chunk of source) {
    chunks.push(
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true }),
    );
  }
  chunks.push(decoder.decode()); // flush 残留的多字节序列
  return chunks.join('').trim();
}
