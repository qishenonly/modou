/**
 * 成本聚合（T-134 /cost）：按会话 / 按天统计 token 与费用。
 *
 * 数据源：会话日志（session/log.ts）的 usage 条目（`{ ts, kind: 'usage',
 * data: UsageData }`）——每一条对应一次模型请求的 token 分项。聚合：
 *
 * - `aggregateUsage`：求和 token 分项（请求数 / 输入 / 输出 / 缓存分项）；
 * - `aggregateCost`：在求和之上按模型定价换算费用（未知模型 priced: false）；
 * - `aggregateByDay`：按 `YYYY-MM-DD`（本地时区）分组，产出逐日合计——
 *   /cost 的「按天统计」视图；跨会话汇总同样适用（传入多会话的 usage 条目）。
 */

import type { SessionRecord, UsageEntryData } from '../session/log';
import type { TokenUsage } from '../provider/types';
import { costForUsage, lookupPrice } from './pricing';
import type { PriceInfo } from './pricing';

/** 一次模型请求的用量（携带时间戳，供按天分组）。 */
export interface TimestampedUsage {
  readonly ts: number;
  readonly usage: UsageEntryData;
}

/** 聚合后的 token 与费用合计。 */
export interface CostTotals {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly noCacheTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** 费用合计（未知模型为 undefined——只报 token，不假装知道价格）。 */
  readonly totalCost?: number;
  /** 该合计是否按定价计算（false = 模型无定价，totalCost 不可信）。 */
  readonly priced: boolean;
}

/** 空合计（请求数为 0）。 */
export const ZERO_COST_TOTALS: CostTotals = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  noCacheTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  priced: false,
};

/**
 * 求和 token 分项（不含费用）。缺省分项按 0 计；`priced` 由调用方在
 * 套价后给出（此处统一 false，`aggregateCost` 会重算）。
 */
export function aggregateUsage(
  entries: readonly TimestampedUsage[],
): CostTotals {
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let noCacheTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const entry of entries) {
    requests += 1;
    inputTokens += entry.usage.inputTokens ?? 0;
    outputTokens += entry.usage.outputTokens ?? 0;
    noCacheTokens += entry.usage.noCacheTokens ?? 0;
    cacheReadTokens += entry.usage.cacheReadTokens ?? 0;
    cacheWriteTokens += entry.usage.cacheWriteTokens ?? 0;
  }
  return {
    requests,
    inputTokens,
    outputTokens,
    noCacheTokens,
    cacheReadTokens,
    cacheWriteTokens,
    priced: false,
  };
}

/**
 * 求和 + 按模型定价换算费用。模型无定价时 `priced: false`、`totalCost`
 * 缺省——只报 token（绝不假装知道价格）。
 */
export function aggregateCost(
  entries: readonly TimestampedUsage[],
  modelId: string,
): CostTotals {
  const totals = aggregateUsage(entries);
  const price = lookupPrice(modelId);
  return applyPrice(totals, price);
}

/** 给已求和的 token 合计套价（模型无定价 → priced: false）。 */
export function applyPrice(
  totals: Omit<CostTotals, 'totalCost' | 'priced'>,
  price: PriceInfo | undefined,
): CostTotals {
  if (price === undefined) return { ...totals, priced: false };
  // 缓存分项口径：上报过 noCache / cacheRead 任一即按分项计；都没上报时
  // 整段输入按输入单价计（inputTokens 是唯一输入口径）。
  const hasCacheBreakdown =
    totals.noCacheTokens > 0 || totals.cacheReadTokens > 0;
  const noCacheForPricing = hasCacheBreakdown
    ? totals.noCacheTokens
    : totals.inputTokens;
  const inputCost =
    (noCacheForPricing / 1_000_000) * price.inputPerMTok +
    (totals.cacheReadTokens / 1_000_000) *
      (price.cacheReadPerMTok ?? price.inputPerMTok);
  const outputCost = (totals.outputTokens / 1_000_000) * price.outputPerMTok;
  return {
    ...totals,
    totalCost: inputCost + outputCost,
    priced: true,
  };
}

// ---------------------------------------------------------------------------
// 会话记录 → 按天聚合
// ---------------------------------------------------------------------------

/** 按天的聚合结果（含日期键）。 */
export interface DayCostTotals extends CostTotals {
  /** `YYYY-MM-DD`（本地时区）。 */
  readonly day: string;
}

/** 从会话记录里抽出全部 usage 条目（带 ts）。非 usage 条目跳过。 */
export function usageEntriesFromRecords(
  records: readonly SessionRecord[],
): TimestampedUsage[] {
  const entries: TimestampedUsage[] = [];
  for (const record of records) {
    if (record.kind === 'usage') {
      entries.push({ ts: record.ts, usage: record.data });
    }
  }
  return entries;
}

/** epoch ms → `YYYY-MM-DD`（本地时区；ts<=0 时归入 'unknown'）。 */
export function dayKey(ts: number): string {
  if (ts <= 0) return 'unknown';
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
}

/**
 * 按天聚合（本地时区）。输入为会话 usage 条目，输出按 `YYYY-MM-DD` 升序的
 * 每日合计（含费用，按 modelId 定价）。无条目返回空数组。
 */
export function aggregateByDay(
  entries: readonly TimestampedUsage[],
  modelId: string,
): DayCostTotals[] {
  const byDay = new Map<string, TimestampedUsage[]>();
  for (const entry of entries) {
    const key = dayKey(entry.ts);
    const bucket = byDay.get(key);
    if (bucket === undefined) {
      byDay.set(key, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  const days = [...byDay.keys()].sort();
  const price = lookupPrice(modelId);
  return days.map((day) => ({
    day,
    ...applyPrice(aggregateUsage(byDay.get(day) ?? []), price),
  }));
}

/** 便捷：一次模型请求的费用（单条 usage，按模型 ID）。 */
export function costOfUsage(usage: TokenUsage, modelId: string): number {
  return costForUsage(usage, modelId).totalCost;
}
