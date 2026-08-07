/**
 * TUI /compact 手动压缩（compact.ts）离线测试。
 *
 * 覆盖：成功路径（折叠早期轮次 / 状态演进 / 会话日志记入 compaction 条目）、
 * 轮次不足降级（no-history，不调生成函数）、未注入生成函数降级（no-generator）、
 * 生成函数失败降级（error，可读 message 不抛出）、手动压缩回写迟滞记账
 * （lastCompactedTurn，此后 K 轮内 loop 自动压缩不重复触发）。
 *
 * 全部离线：generateDelta 一律注入 stub。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from '@modou/core';
import { createSummaryState, merge, SessionLog } from '@modou/core';
import type { CompactOptions, SessionRecord } from '@modou/core';
import { performCompact } from './compact';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const assistant = (text: string): ModelMessage => ({
  role: 'assistant',
  content: text,
});

/** 四条轮次的典型线程（早期 + 中期 + 近期 + 当前输入）。 */
function longThread(): ModelMessage[] {
  return [
    user('任务开始'),
    assistant('好的，开始执行。'),
    user('读 config'),
    assistant('读到了配置。'),
    user('修改文件'),
    assistant('文件已修改。'),
    user('当前输入'),
  ];
}

describe('performCompact（TUI /compact 手动压缩）', () => {
  test('成功：折叠早期轮次、状态演进、会话日志记入 compaction 条目', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'modou-tui-compact-'));
    try {
      const session = new SessionLog({ homeDir, cwd: homeDir });
      const state = merge(createSummaryState(), { goal: '长任务' });
      const compact: CompactOptions = {
        keepTurns: 1,
        generateDelta: async () => ({
          findings: [{ id: 'f', text: '已折叠早期轮次' }],
        }),
      };
      const result = await performCompact({
        historyMessages: longThread(),
        summaryState: state,
        compact,
        session,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // 4 轮线程 - keepTurns 1 = 折叠前 3 轮
      expect(result.outcome.event.coveredTurns).toEqual([1, 3]);
      expect(result.outcome.event.beforeTokens).toBeGreaterThan(0);
      expect(result.outcome.event.afterTokens).toBeGreaterThan(0);
      // 状态演进：goal 未改写、delta 已合并、rev +1
      expect(result.summaryState.rev).toBe(state.rev + 1);
      expect(result.summaryState.goal).toBe('长任务');
      expect(result.summaryState.findings.map((item) => item.text)).toContain(
        '已折叠早期轮次',
      );

      // 会话日志：一条 compaction 条目（/resume 重建依据）
      const lines = readFileSync(session.path, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      const records = lines.map((line) => JSON.parse(line) as SessionRecord);
      const comp = records.find((record) => record.kind === 'compaction');
      expect(comp).toBeDefined();
      const data = comp!.data as {
        covers: readonly [number, number];
        summaryRev: number;
      };
      expect(data.covers).toEqual([1, 3]);
      expect(data.summaryRev).toBe(state.rev + 1);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('轮次不足：no-history 降级（不调生成函数、不写日志）', async () => {
    let generated = 0;
    const result = await performCompact({
      historyMessages: [user('单轮')],
      summaryState: createSummaryState(),
      compact: {
        keepTurns: 2,
        generateDelta: async () => {
          generated += 1;
          return {};
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-history');
    expect(result.message).toContain('轮次不足');
    expect(generated).toBe(0); // 未触发生成
  });

  test('未注入生成函数：no-generator 降级', async () => {
    const result = await performCompact({
      historyMessages: longThread(),
      summaryState: createSummaryState(),
      compact: { keepTurns: 1 }, // 无 generateDelta
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-generator');
  });

  test('生成函数失败：error 降级（可读 message，不抛出）', async () => {
    const result = await performCompact({
      historyMessages: longThread(),
      summaryState: createSummaryState(),
      compact: {
        keepTurns: 1,
        generateDelta: async () => {
          throw new Error('模型挂了');
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('error');
    expect(result.message).toContain('模型挂了');
  });

  test('手动压缩回写迟滞记账：lastCompactedTurn 设置（此后 K 轮内不重复自动触发）', async () => {
    const state = {
      ...merge(createSummaryState(), { goal: '长任务' }),
      turnCount: 7,
    };
    const result = await performCompact({
      historyMessages: longThread(),
      summaryState: state,
      compact: {
        keepTurns: 1,
        generateDelta: async () => ({ findings: [{ text: 'x' }] }),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summaryState.lastCompactedTurn).toBe(7);
    expect(result.summaryState.turnCount).toBe(7); // 轮次计数不变（压缩发生在轮间）
  });
});
