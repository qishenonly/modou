/**
 * /compact 手动压缩助手（与 packages/tui/src/compact.ts 同源移植）。
 *
 * 与 loop 自动压缩（runtime/loop.ts ASSEMBLE 阶段）同口径：用 `runCompaction`
 * 把除近 keepTurns 轮外的早期轮次折叠进摘要（增量合并，rev+1），成功后回写
 * 迟滞记账并把 compaction 条目记入会话日志（/resume 重建依据）。失败归一为
 * `ok:false` + 可读 message，不抛出。
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
  readonly historyMessages: readonly ModelMessage[];
  readonly summaryState: SummaryState | undefined;
  readonly compact: CompactOptions;
  readonly session?: SessionLog | null;
}

/** performCompact 的产出：成功（含事件负载与新状态）/ 降级失败（可读 message）。 */
export type PerformCompactResult =
  | {
      readonly ok: true;
      readonly outcome: CompactionOutcome;
      readonly summaryState: SummaryState;
    }
  | {
      readonly ok: false;
      readonly reason: 'no-history' | 'no-generator' | 'error';
      readonly message: string;
    };

/** 执行一次手动压缩（/compact）。任何失败都归一为 `ok:false`。 */
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
