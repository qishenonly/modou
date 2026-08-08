/**
 * 成本追踪（T-134 /cost，0.13.0）：多供应商定价表 + token → 费用计算。
 *
 * 数据源是协议 usage 事件（token 分项 / 缓存命中）与供应商模型 ID。定价表
 * 按**模型 ID** 组织（前缀匹配，容纳版本化 ID 如 `gpt-4o-2024-08-06`）——
 * openai-compat / opencode 网关只是「承运」，真正计费的是模型名，因此以
 * 模型 ID 为键，不按供应商分开两张表。
 *
 * 定价为公开价目（USD / 1M tokens）的近似快照；未知模型返回 undefined
 * （`priced: false`），只统计 token 不算钱——绝不假装知道价格。
 * 精确价格随供应商更新，此处是尽力而为的估算，文档标注「以供应商账单为准」。
 */

import type { TokenUsage } from '../provider/types';

// ---------------------------------------------------------------------------
// 定价表（USD / 1M tokens；公开价目的近似快照）
// ---------------------------------------------------------------------------

/** 一个模型的单价（USD / 1M tokens）。 */
export interface PriceInfo {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  /** 缓存命中的输入单价（缺省 = inputPerMTok）。 */
  readonly cacheReadPerMTok?: number;
  /** 缓存写入的输入单价（缺省 = inputPerMTok）。 */
  readonly cacheWritePerMTok?: number;
}

/** 定价表：模型 ID → 单价（前缀匹配；越长的前缀越先匹配）。 */
const PRICING_BY_MODEL: Readonly<Record<string, PriceInfo>> = {
  // —— OpenAI（openai-compat / opencode 的 GPT 家族）——
  'gpt-5.6': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gpt-5-luna': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2 },
  'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gpt-4.5': { inputPerMTok: 75, outputPerMTok: 150 },
  'gpt-4.1-mini': { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  'gpt-4.1-nano': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  'gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8 },
  'gpt-4o-mini': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cacheReadPerMTok: 0.075,
  },
  'gpt-4o': {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    cacheReadPerMTok: 1.25,
  },
  'gpt-4': { inputPerMTok: 30, outputPerMTok: 60 },
  'o3-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  o3: { inputPerMTok: 2, outputPerMTok: 8 },
  'o1-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  o1: { inputPerMTok: 15, outputPerMTok: 60 },

  // —— DeepSeek（opencode 网关的 deepseek 家族）——
  'deepseek-reasoner': { inputPerMTok: 0.55, outputPerMTok: 2.19 },
  'deepseek-v4-flash': { inputPerMTok: 0.27, outputPerMTok: 1.1 },
  'deepseek-v4': { inputPerMTok: 0.55, outputPerMTok: 2.19 },
  'deepseek-chat': { inputPerMTok: 0.27, outputPerMTok: 1.1 },

  // —— Anthropic（anthropic 供应商）——
  'claude-sonnet-4-5': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
  },
  'claude-sonnet-4': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
  },
  'claude-opus-4-1': {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
  },
  'claude-opus-4': {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
  },
  'claude-haiku': { inputPerMTok: 0.8, outputPerMTok: 4 },
};

/**
 * 按模型 ID 查价：先精确匹配，再按前缀匹配（最长前缀优先），
 * 都不中返回 undefined——只报 token 不算钱（绝不假装知道价格）。
 */
export function lookupPrice(modelId: string): PriceInfo | undefined {
  const exact = PRICING_BY_MODEL[modelId];
  if (exact !== undefined) return exact;
  const prefixes = Object.keys(PRICING_BY_MODEL)
    .filter((key) => modelId.startsWith(key))
    .sort((a, b) => b.length - a.length);
  if (prefixes.length === 0) return undefined;
  return PRICING_BY_MODEL[prefixes[0]];
}

// ---------------------------------------------------------------------------
// 费用计算
// ---------------------------------------------------------------------------

/** 一次用量 → 费用分项（未知模型 priced: false，费用全 0）。 */
export interface CostBreakdown {
  /** 未命中缓存的输入费用（回退 inputTokens 口径） */
  readonly inputCost: number;
  /** 缓存命中的输入费用 */
  readonly cacheReadCost: number;
  readonly outputCost: number;
  readonly totalCost: number;
  /** 是否有定价（未知模型为 false——费用不可信，只可报 token） */
  readonly priced: boolean;
}

/**
 * 把一次 token 用量换算为费用。
 *
 * 口径：输入 = 未命中缓存部分 × 输入单价 + 命中缓存部分 × 缓存单价
 * （供应商上报了 noCache/cacheRead 分项时）；未上报分项时整段按输入单价计。
 * 输出按输出单价。单位换算：token / 1_000_000 × 每百万单价。
 */
export function computeCost(
  usage: TokenUsage,
  price: PriceInfo | undefined,
): CostBreakdown {
  if (price === undefined) {
    return {
      inputCost: 0,
      cacheReadCost: 0,
      outputCost: 0,
      totalCost: 0,
      priced: false,
    };
  }
  const noCache = usage.noCacheTokens ?? usage.inputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const inputCost = (noCache / 1_000_000) * price.inputPerMTok;
  const cacheReadCost =
    (cacheRead / 1_000_000) * (price.cacheReadPerMTok ?? price.inputPerMTok);
  const outputCost =
    ((usage.outputTokens ?? 0) / 1_000_000) * price.outputPerMTok;
  return {
    inputCost,
    cacheReadCost,
    outputCost,
    totalCost: inputCost + cacheReadCost + outputCost,
    priced: true,
  };
}

/** 一次用量 + 模型 ID → 费用分项（便捷入口：内部查价）。 */
export function costForUsage(
  usage: TokenUsage,
  modelId: string,
): CostBreakdown {
  return computeCost(usage, lookupPrice(modelId));
}
