/**
 * /init（T-132）：分析仓库结构 → 生成 AGENTS.md 初稿。
 * 探测是只读、同步、一次性的；模板固定，探测结果填充占位符。
 */
export { probeRepository, generateAgentsMd, runInit } from './probe';
export type { RepositoryProfile, InitResult, PackageManager } from './probe';
