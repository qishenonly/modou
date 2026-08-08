/**
 * 成本追踪（T-134 /cost）：多供应商定价表 + token → 费用 + 会话 / 天聚合。
 * 数据源是 usage 事件（协议 / 会话日志），输出可渲染的成本报告。
 */
export { lookupPrice, computeCost, costForUsage } from './pricing';
export type { PriceInfo, CostBreakdown } from './pricing';
export {
  aggregateUsage,
  aggregateCost,
  aggregateByDay,
  applyPrice,
  usageEntriesFromRecords,
  dayKey,
  costOfUsage,
  ZERO_COST_TOTALS,
} from './aggregate';
export type { CostTotals, DayCostTotals, TimestampedUsage } from './aggregate';
