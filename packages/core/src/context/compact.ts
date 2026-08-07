/**
 * 压缩决策与投影（design 002 §7.2，T-070）。
 *
 * 002 4.1「上下文是日志的投影」：压缩只是**投影时用摘要代替某段原文**，
 * 日志里的原文仍在。本模块把这一语义拆成三个纯函数 + 一个驱动：
 *
 * - `splitThreadIntoTurns`：把消息线程切成轮（从 user 消息分界），
 *   投影与压缩都以轮为单位折叠——保证不会把 assistant 的 tool-call 与其
 *   tool-result 拆散（AI SDK 要求 tool 消息紧跟对应 assistant 消息）；
 * - `isCompactionNeeded`：上下文估算超阈值（002 7.3 预算核算的触发点）；
 * - `compactProjection`：超阈值且有摘要状态时，把**早期轮次**替换为摘要块、
 *   保留**近 N 轮原文**与当前输入（可配 keepTurns / thresholdTokens）；
 *   原始线程不被修改（「只影响投影」）；
 * - `runCompaction`：调用注入的摘要生成函数（生产由模型生成，测试注入
 *   stub）产出 delta → `merge` 进既有状态（增量合并，rev+1）→ 返回新状态
 *   与协议 `compaction` 事件负载（压缩前后 token、被折叠的轮次范围）。
 *
 * 依赖方向：只依赖协议类型（CompactionData）、预算估算（estimateTokens）、
 * 分项序列化（serializeMessageText）与本模块的 summary——不感知 provider /
 * runtime 内部。
 */

import type { ModelMessage } from 'ai';
import type { CompactionData } from '../protocol/events';
import { estimateTokens } from './budget';
import { serializeMessageText } from './project';
import {
  isEmptySummary,
  merge,
  SUMMARY_LIST_NAMES,
  type FileNote,
  type SummaryDelta,
  type SummaryItem,
  type SummaryState,
} from './summary';
/** 摘要增量：生成函数产出的类型（consumer 直接从这里导入，不必感知 summary 内部）。 */
export type { SummaryDelta };

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 摘要块占位消息的构造：把 SummaryState 渲染成一条模型消息（缺省 system 角色）。 */
export type SummaryBlockBuilder = (state: SummaryState) => ModelMessage;

/** 摘要生成函数的入参：被折叠的原文（即将被摘要代替）+ 当前状态。 */
export interface SummaryDeltaGeneratorInput {
  /** 被折叠的原文消息（早期轮次；空 = 无可折叠内容）。 */
  readonly folded: readonly ModelMessage[];
  /** 当前摘要状态（生成的 delta 将 merge 进它）。 */
  readonly state: SummaryState;
}

/**
 * 摘要生成函数（可注入；生产由模型生成增量，测试注入 stub）。
 * 返回一个 SummaryDelta：`merge` 把它合并进既有状态（增量合并，非全量重写）。
 */
export type SummaryDeltaGenerator = (
  input: SummaryDeltaGeneratorInput,
) => Promise<SummaryDelta>;

/** 压缩配置（compactProjection / runCompaction 共用）。 */
export interface CompactOptions {
  /** 保留近 N 轮原文（缺省 6；更早轮次被摘要块代替）。 */
  readonly keepTurns?: number;
  /** 上下文估算的压缩触发阈值（token；缺省 = 不按阈值触发）。 */
  readonly thresholdTokens?: number;
  /**
   * 迟滞窗口（T-070）：压缩后 K 轮内不再触发自动压缩（缺省 5；0 = 关闭迟滞）。
   * 判定以摘要状态的 turnCount / lastCompactedTurn 记账为准（跨 runAgentTurn
   * 接续），避免跨阈值后每轮重复压缩；compaction 事件与日志只在该触发时产生。
   */
  readonly minTurnsBetweenCompactions?: number;
  /** 摘要块占位消息的构造（缺省 buildSummaryBlock：system 角色）。 */
  readonly buildSummaryBlock?: SummaryBlockBuilder;
  /** 摘要生成函数（缺省 = 未注入；runCompaction 需要它才可运行）。 */
  readonly generateDelta?: SummaryDeltaGenerator;
}

/** runCompaction 的产出：新状态 + 增量 + 协议 compaction 事件负载 + 折叠区原文。 */
export interface CompactionOutcome {
  readonly state: SummaryState;
  readonly delta: SummaryDelta;
  /** 协议 `compaction` 事件负载（压缩前后 token、折叠轮次范围）。 */
  readonly event: CompactionData;
  /** 被折叠的原文消息（与 event.beforeTokens 对应的区域）。 */
  readonly folded: readonly ModelMessage[];
}

/** 默认保留的原文轮数（002 7.1 易变区「近 N 轮原文」的 N）。 */
export const DEFAULT_KEEP_TURNS = 6;

/** 默认迟滞窗口：压缩后 5 轮内不再触发自动压缩（T-070）。 */
export const DEFAULT_MIN_TURNS_BETWEEN_COMPACTIONS = 5;

// ---------------------------------------------------------------------------
// 摘要块渲染
// ---------------------------------------------------------------------------

/** 各列表的中文标签（serializeSummary 输出顺序 = SUMMARY_LIST_NAMES）。 */
const LIST_LABELS: Readonly<Record<string, string>> = {
  constraints: '约束',
  decisions: '决定',
  done: '已完成',
  todo: '待办',
  findings: '关键发现',
  openQuestions: '未决问题',
};

/** 渲染一条摘要条目为 `- text`（带 note 时追加备注）。 */
function serializeItem(item: SummaryItem): string {
  return `- ${item.text}`;
}

/** 渲染一条文件备注为 `- path（note）`。 */
function serializeFileNote(note: FileNote): string {
  return note.note === undefined || note.note.length === 0
    ? `- ${note.path}`
    : `- ${note.path}（${note.note}）`;
}

/**
 * 把 SummaryState 渲染为摘要块文本（供 buildSummaryBlock 与事件核算）。
 * 只输出有内容的节，保持块尽可能紧凑（它要放进模型上下文）。
 */
export function serializeSummary(state: SummaryState): string {
  const lines: string[] = [`【压缩摘要 rev=${state.rev}】`];
  if (state.goal.length > 0) lines.push(`目标：${state.goal}`);
  for (const name of SUMMARY_LIST_NAMES) {
    const items = state[name] as readonly SummaryItem[];
    if (items.length === 0) continue;
    lines.push(`${LIST_LABELS[name]}：`);
    lines.push(...items.map(serializeItem));
  }
  if (state.filesTouched.length > 0) {
    lines.push('触及文件：');
    lines.push(...state.filesTouched.map(serializeFileNote));
  }
  return lines.join('\n');
}

/**
 * 摘要占位块：一条 system 角色的模型消息（内容 = serializeSummary）。
 * system 角色在 messages 数组中任意位置均可解析（provider 侧配合
 * allowSystemInMessages，见 provider/vercel.ts）——它不会被误当作用户输入，
 * 语义上就是「较早对话的压缩摘要」。
 */
export function buildSummaryBlock(state: SummaryState): ModelMessage {
  return { role: 'system', content: serializeSummary(state) };
}

// ---------------------------------------------------------------------------
// 轮次切分（折叠的单位）
// ---------------------------------------------------------------------------

/**
 * 把消息线程切成轮：从 user 消息开始，直到下一条 user 消息为止。
 * 每轮 = [user, assistant（含 tool-call）, tool（结果）, …]；
 * 按轮折叠保证 assistant 的 tool-call 与其 tool-result 不分离。
 */
export function splitThreadIntoTurns(
  thread: readonly ModelMessage[],
): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  let current: ModelMessage[] = [];
  for (const message of thread) {
    if (message.role === 'user' && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

// ---------------------------------------------------------------------------
// 触发决策
// ---------------------------------------------------------------------------

/**
 * 上下文估算是否超压缩阈值（002 7.3：请求前本地粗估，与分项视图同源）。
 * thresholdTokens 未配置或 ≤ 0 时恒 false（不按阈值触发）。
 */
export function isCompactionNeeded(
  thread: readonly ModelMessage[],
  thresholdTokens: number | undefined,
): boolean {
  if (thresholdTokens === undefined || thresholdTokens <= 0) return false;
  let total = 0;
  for (const message of thread) {
    total += estimateTokens(serializeMessageText(message));
  }
  return total > thresholdTokens;
}

// ---------------------------------------------------------------------------
// 投影：早期轮次 → 摘要块，近 N 轮原文保留
// ---------------------------------------------------------------------------

/**
 * 投影（002 4.1「上下文是日志的投影」）：把早期轮次替换为摘要块，
 * 近 N 轮原文保留（含当前输入轮）。
 *
 * 折叠条件（全部满足才折叠）：
 * 1. 传入摘要状态且非空（rev 0 且无任何内容 = 没有可展示的摘要）；
 * 2. 轮数超过 keepTurns；
 * 3. 配置了 thresholdTokens 时，线程估算须超阈值（未配置则不按阈值门控）。
 *
 * 原始线程**不被修改**（返回新数组；日志原文仍在，只影响发给模型的投影）。
 * 折叠按轮切分，当前输入轮恒在保留区内（keepTurns ≥ 1）。
 */
export function compactProjection(
  thread: readonly ModelMessage[],
  summaryState: SummaryState | undefined,
  options: CompactOptions = {},
): ModelMessage[] {
  const keepTurns = options.keepTurns ?? DEFAULT_KEEP_TURNS;
  if (summaryState === undefined || isEmptySummary(summaryState)) {
    return [...thread];
  }
  if (
    options.thresholdTokens !== undefined &&
    !isCompactionNeeded(thread, options.thresholdTokens)
  ) {
    return [...thread];
  }
  const turns = splitThreadIntoTurns(thread);
  if (turns.length <= keepTurns) return [...thread];
  const foldedCount = turns.length - keepTurns;
  const block = (options.buildSummaryBlock ?? buildSummaryBlock)(summaryState);
  return [block, ...turns.slice(foldedCount).flat()];
}

// ---------------------------------------------------------------------------
// 压缩驱动：生成 delta → merge → 新 rev + compaction 事件负载
// ---------------------------------------------------------------------------

/**
 * 执行一次压缩（T-070 /compact 语义的 core 侧）：生成 delta → 增量合并 →
 * 产出新 rev 与协议 `compaction` 事件负载。
 *
 * - 被折叠区 = 除近 keepTurns 轮外的早期轮次（与 compactProjection 同口径）；
 * - 摘要生成函数须已注入（`generateDelta`；生产由模型生成，测试注入 stub），
 *   未注入时抛出（调用方决定跳过还是报错）；
 * - `event.coveredTurns` 为当前线程的轮次序号（1-based）：[1, 折叠轮数]，
 *   无折叠时 [0, 0]；
 * - `event.beforeTokens` / `afterTokens`：折叠区原文 vs 摘要块的 token 估算
 *   （字符级近似，budget.ts「精度取舍」——压缩前后对比同样是估算口径）。
 */
export async function runCompaction(
  thread: readonly ModelMessage[],
  summaryState: SummaryState,
  options: CompactOptions,
): Promise<CompactionOutcome> {
  const keepTurns = options.keepTurns ?? DEFAULT_KEEP_TURNS;
  const turns = splitThreadIntoTurns(thread);
  const foldedCount = Math.max(0, turns.length - keepTurns);
  const folded: ModelMessage[] =
    foldedCount === 0 ? [] : turns.slice(0, foldedCount).flat();

  const generateDelta = options.generateDelta;
  if (generateDelta === undefined) {
    throw new Error(
      '未注入摘要生成函数（compact.generateDelta）：生产由模型生成增量，测试注入 stub',
    );
  }
  const delta = await generateDelta({ folded, state: summaryState });
  const state = merge(summaryState, delta);
  const block = (options.buildSummaryBlock ?? buildSummaryBlock)(state);

  const beforeTokens = estimateTokens(
    folded.map(serializeMessageText).join('\n'),
  );
  const afterTokens = estimateTokens(serializeMessageText(block));
  const coveredTurns: readonly [number, number] =
    foldedCount === 0 ? [0, 0] : [1, foldedCount];

  return {
    state,
    delta,
    event: { beforeTokens, afterTokens, coveredTurns },
    folded,
  };
}
