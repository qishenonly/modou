/**
 * T-134 /cost 离线测试。
 *
 * 覆盖：
 * - lookupPrice：精确 / 前缀匹配（版本化模型 ID）/ 未知模型 → undefined；
 * - computeCost / costOfUsage：输入 / 输出 / 缓存命中分档计费；
 * - aggregateUsage / aggregateCost：会话级 token 与费用合计；
 * - aggregateByDay：按天分组（本地时区）升序输出；
 * - 未知模型：只报 token、totalCost 缺省、priced: false（绝不假装知道价格）。
 *
 * 全部离线：纯函数计算，不访问外网。
 */
import { describe, expect, test } from 'bun:test';
import {
  aggregateByDay,
  aggregateCost,
  aggregateUsage,
  computeCost,
  costOfUsage,
  dayKey,
  lookupPrice,
  usageEntriesFromRecords,
} from './index';
import type { SessionRecord } from '../session/log';

describe('lookupPrice（T-134 定价表）', () => {
  test('精确匹配 + 前缀匹配（版本化模型 ID）', () => {
    expect(lookupPrice('gpt-4o')?.inputPerMTok).toBe(2.5);
    // 版本化 ID 走前缀匹配
    expect(lookupPrice('gpt-4o-2024-08-06')?.inputPerMTok).toBe(2.5);
    expect(lookupPrice('deepseek-v4-flash')?.inputPerMTok).toBe(0.27);
    expect(lookupPrice('deepseek-v4-flash-1234')?.inputPerMTok).toBe(0.27);
  });

  test('未知模型 → undefined（只报 token，不假装知道价格）', () => {
    expect(lookupPrice('llama-3-70b')).toBeUndefined();
    expect(lookupPrice('')).toBeUndefined();
  });
});

describe('computeCost（T-134 费用计算）', () => {
  test('输入 / 输出 / 缓存命中分档计费（USD）', () => {
    // gpt-4o：输入 $2.5/M、输出 $10/M、缓存命中 $1.25/M
    const cost = computeCost(
      {
        inputTokens: 1_000_000,
        noCacheTokens: 400_000,
        cacheReadTokens: 600_000,
        outputTokens: 500_000,
      },
      lookupPrice('gpt-4o'),
    );
    expect(cost.priced).toBe(true);
    expect(cost.inputCost).toBeCloseTo(1.0, 6); // 0.4M × 2.5/M
    expect(cost.cacheReadCost).toBeCloseTo(0.75, 6); // 0.6M × 1.25/M
    expect(cost.outputCost).toBeCloseTo(5.0, 6); // 0.5M × 10/M
    expect(cost.totalCost).toBeCloseTo(6.75, 6);
  });

  test('未知模型 → priced: false、费用全 0', () => {
    const cost = computeCost({ inputTokens: 100, outputTokens: 50 }, undefined);
    expect(cost.priced).toBe(false);
    expect(cost.totalCost).toBe(0);
  });

  test('未上报缓存分项时整段按输入单价计', () => {
    const cost = costOfUsage(
      { inputTokens: 1_000_000, outputTokens: 0 },
      'gpt-4o',
    );
    expect(cost).toBeCloseTo(2.5, 6);
  });
});

describe('aggregateUsage / aggregateCost（T-134 会话聚合）', () => {
  test('求和 token 分项 + 请求数', () => {
    const totals = aggregateUsage([
      {
        ts: 1,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4 },
      },
      { ts: 2, usage: { inputTokens: 20, outputTokens: 10 } },
    ]);
    expect(totals.requests).toBe(2);
    expect(totals.inputTokens).toBe(30);
    expect(totals.outputTokens).toBe(15);
    expect(totals.cacheReadTokens).toBe(4);
    expect(totals.totalCost).toBeUndefined();
  });

  test('套价后给出会话总费用', () => {
    const totals = aggregateCost(
      [
        { ts: 1, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
        { ts: 2, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
      ],
      'deepseek-chat', // $0.27 / $1.10 每百万
    );
    expect(totals.requests).toBe(2);
    expect(totals.priced).toBe(true);
    // 2M input × 0.27 + 2M output × 1.10 = 0.54 + 2.20 = 2.74
    expect(totals.totalCost).toBeCloseTo(2.74, 6);
  });
});

describe('aggregateByDay（T-134 按天统计）', () => {
  test('按本地时区日期分组，升序输出；每组合计费用', () => {
    const dayTotals = aggregateByDay(
      [
        {
          ts: new Date(2026, 7, 8, 10, 0).getTime(),
          usage: { inputTokens: 100, outputTokens: 50 },
        },
        {
          ts: new Date(2026, 7, 8, 22, 0).getTime(),
          usage: { inputTokens: 200, outputTokens: 100 },
        },
        {
          ts: new Date(2026, 7, 9, 9, 0).getTime(),
          usage: { inputTokens: 300, outputTokens: 150 },
        },
      ],
      'gpt-4o-mini', // $0.15 / $0.6 每百万
    );
    expect(dayTotals.map((d) => d.day)).toEqual(['2026-08-08', '2026-08-09']);
    expect(dayTotals[0]?.requests).toBe(2);
    expect(dayTotals[0]?.inputTokens).toBe(300);
    expect(dayTotals[0]?.totalCost).toBeCloseTo(
      (300 / 1e6) * 0.15 + (150 / 1e6) * 0.6,
      9,
    );
    expect(dayTotals[1]?.requests).toBe(1);
  });

  test('空输入 → 空数组', () => {
    expect(aggregateByDay([], 'gpt-4o')).toEqual([]);
  });

  test('dayKey：本地时区 YYYY-MM-DD；ts<=0 → unknown', () => {
    expect(dayKey(new Date(2026, 7, 8, 0, 0).getTime())).toBe('2026-08-08');
    expect(dayKey(0)).toBe('unknown');
  });
});

describe('usageEntriesFromRecords（T-134 会话记录抽取）', () => {
  test('只抽 usage 条目，其余 kind 跳过', () => {
    const records: SessionRecord[] = [
      { seq: 1, ts: 100, kind: 'user', data: { text: 'hi' } },
      {
        seq: 2,
        ts: 101,
        kind: 'usage',
        data: { inputTokens: 5, outputTokens: 2 },
      },
      {
        seq: 3,
        ts: 102,
        kind: 'turn_end',
        data: { turn: 1, termination: 'end_turn' },
      },
      { seq: 4, ts: 103, kind: 'usage', data: { inputTokens: 8 } },
    ];
    const entries = usageEntriesFromRecords(records);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.usage.inputTokens).toBe(5);
    expect(entries[1]?.ts).toBe(103);
  });
});
