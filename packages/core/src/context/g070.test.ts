/**
 * G-0.7.0 验收：长任务压缩保真 + 缓存命中率。
 *
 * 模拟 45 轮对话、多次触发压缩（每 5 轮一次），断言：
 * - goal 与 filesTouched（硬事实）全程保留；
 * - 各轮注入的事实（decisions/done/todo/findings）在增量合并后不逐轮流失；
 * - 投影后早期轮次被摘要块替换、近 N 轮原文保留；
 * - 缓存命中率在摘要稳定后上升、摘要改写后回落。
 */
import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import {
  BudgetLedger,
  compactProjection,
  merge,
  type SummaryState,
} from './index';

function factState(rev: number, facts: string[]): SummaryState {
  return {
    rev,
    goal: '修复支付模块并补全测试',
    constraints: [],
    decisions: facts.map((text, i) => ({ id: `d${i}`, text, ts: i })),
    done: [],
    todo: [],
    filesTouched: [{ path: '/repo/payment.ts', note: '支付模块' }],
    findings: [],
    openQuestions: [],
  };
}

/** 构造一轮对话（user + assistant + tool 结果）。 */
function buildTurn(n: number): ModelMessage[] {
  const key = `fact-${n}`;
  return [
    { role: 'user', content: `第 ${n} 轮：实现 ${key}` },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `完成 ${key}` },
        {
          type: 'tool-call',
          toolCallId: `c${n}`,
          toolName: 'edit',
          input: { path: '/repo/payment.ts' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `c${n}`,
          toolName: 'edit',
          output: { type: 'text', value: 'ok' },
        },
      ],
    },
  ];
}

describe('G-0.7.0 长任务压缩保真', () => {
  test('45 轮多次压缩后硬事实与全部事实保留', () => {
    // 逐轮构建线程 + 增量合并（模拟每次压缩生成器把新轮事实并入摘要）
    let thread: ModelMessage[] = [];
    let state: SummaryState | null = null;
    const injected: string[] = [];

    for (let n = 1; n <= 45; n++) {
      thread = [...thread, ...buildTurn(n)];
      const fact = `第 ${n} 轮决定使用策略 ${n}`;
      injected.push(fact);
      state = merge(state ?? factState(0, []), factState(n, [fact]));

      // 每 5 轮触发一次压缩投影（超过 keepTurns=6 轮后才真正折叠）
      if (n % 5 === 0 && state !== null) {
        const projected = compactProjection(thread, state, {
          keepTurns: 6,
        });
        if (n > 6) {
          // 折叠生效：近 6 轮原文 + 摘要块 < 原始线程；摘要块在最前（system 角色）
          expect(projected.length).toBeLessThan(thread.length);
          expect(projected[0]?.role).toBe('system');
        } else {
          // 未超过保留轮数：原样返回
          expect(projected.length).toBe(thread.length);
        }
      }
    }

    // 硬事实白名单：goal 与 filesTouched 全程保留
    expect(state?.goal).toBe('修复支付模块并补全测试');
    expect(state?.filesTouched).toHaveLength(1);
    expect(state?.filesTouched[0]?.path).toBe('/repo/payment.ts');
    // 全部 45 个事实都在（rev=45 增量合并，无 context collapse）
    expect(state?.rev).toBe(45);
    expect(state?.decisions).toHaveLength(45);
    for (const fact of injected) {
      expect(state?.decisions.some((d) => d.text === fact)).toBe(true);
    }
  });

  test('缓存命中率：稳定前缀命中率上升，摘要改写后回落', () => {
    const ledger = new BudgetLedger();
    // 稳定前缀连续命中
    ledger.recordUsage({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 900,
      noCacheTokens: 100,
    });
    ledger.recordUsage({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 950,
      noCacheTokens: 50,
    });
    expect(ledger.cacheHitRate()).toBeCloseTo(1850 / 2000);
    // 压缩改写摘要块 → 前缀失效 → noCache 上升
    ledger.recordUsage({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 100,
      noCacheTokens: 900,
    });
    expect(ledger.cacheHitRate()).toBeCloseTo(1950 / 3000);
  });
});
