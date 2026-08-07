/**
 * /compact 手动压缩助手（T-070）：把「当前投影历史 + 既有摘要状态 + 压缩配置」
 * 执行一次压缩，供 runTui 的 /compact 斜杠命令与测试复用。
 *
 * 与 loop 自动压缩（runtime/loop.ts ASSEMBLE 阶段）同口径：用
 * `runCompaction` 把除近 keepTurns 轮外的早期轮次折叠进摘要（增量合并，
 * rev+1），随后回写迟滞记账 `lastCompactedTurn`（此后 K 轮内 loop 自动压缩
 * 不再触发——用户手动 /compact 是显式要求，但一次就够）。压缩成功后把
 * compaction 条目追加进会话日志（/resume 重建依据，002 4.2）。
 *
 * 失败降级：解析失败 / provider 抛错一律归一为 `ok:false` + 可读 message，
 * 不抛出（调用方把它发成 notice）。
 */

import type { ModelMessage } from '@modou/core';
import {
  createSummaryState,
  runCompaction,
  splitThreadIntoTurns,
  DEFAULT_KEEP_TURNS,
} from '@modou/core';
import type {
  CompactOptions,
  CompactionOutcome,
  SessionLog,
  SummaryState,
} from '@modou/core';

/** performCompact 的入参。 */
export interface PerformCompactInput {
  /** 当前投影出的完整历史（上下文是日志的投影，002 4.1；runTui 持有）。 */
  readonly historyMessages: readonly ModelMessage[];
  /** 既有摘要状态（缺省 = 从空状态开始，首轮压缩即产出内容）。 */
  readonly summaryState: SummaryState | undefined;
  /** 压缩配置（缺省缺省值由 runTui 装配；测试注入 stub generateDelta）。 */
  readonly compact: CompactOptions;
  /** 会话日志（可选）：压缩成功后追加 compaction 条目（/resume 重建依据）。 */
  readonly session?: SessionLog | null;
}

/** performCompact 的产出：成功（含事件负载与新状态）/ 降级失败（可读 message）。 */
export type PerformCompactResult =
  | {
      readonly ok: true;
      /** 协议 compaction 事件负载（压缩前后 token、折叠轮次范围）。 */
      readonly outcome: CompactionOutcome;
      /** 压缩后的摘要状态（调用方接续跨轮传回）。 */
      readonly summaryState: SummaryState;
    }
  | {
      readonly ok: false;
      /** 降级原因：轮次不足 / 未注入生成函数 / 执行失败。 */
      readonly reason: 'no-history' | 'no-generator' | 'error';
      readonly message: string;
    };

/**
 * 执行一次手动压缩（/compact）。成功时回写迟滞记账并把 compaction 条目记入
 * 会话日志；任何失败都归一为 `ok:false`（不抛出）。
 */
export async function performCompact(
  input: PerformCompactInput,
): Promise<PerformCompactResult> {
  const keepTurns = input.compact.keepTurns ?? DEFAULT_KEEP_TURNS;
  if (splitThreadIntoTurns(input.historyMessages).length <= keepTurns) {
    return {
      ok: false,
      reason: 'no-history',
      message: '对话轮次不足，暂无可压缩内容',
    };
  }
  if (input.compact.generateDelta === undefined) {
    return {
      ok: false,
      reason: 'no-generator',
      message: '未注入摘要生成函数，无法压缩',
    };
  }
  try {
    const state = input.summaryState ?? createSummaryState();
    const outcome = await runCompaction(
      [...input.historyMessages],
      state,
      input.compact,
    );
    // 迟滞记账：手动压缩同样回写 lastCompactedTurn，此后 K 轮内 loop 不再自动触发
    const next = { ...outcome.state, lastCompactedTurn: state.turnCount ?? 0 };
    await input.session?.appendCompaction({
      covers: outcome.event.coveredTurns,
      summaryRev: outcome.state.rev,
      state: next,
    });
    return { ok: true, outcome, summaryState: next };
  } catch (caught) {
    return {
      ok: false,
      reason: 'error',
      message: `压缩失败（${caught instanceof Error ? caught.message : String(caught)}），摘要保持不变`,
    };
  }
}
