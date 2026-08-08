/**
 * 联网工具支撑模块（0.17.0 T-171/T-172）。
 *
 * - html.ts：HTML → 纯文本（抓取正文转换，零依赖正则实现）；
 * - domain.ts：域名白名单 / 黑名单过滤（settings web 键的消费形态）；
 * - context.ts：外部内容的提示注入防护（ADR 0017：来源标记 + 边界包裹 +
 *   数据非指令声明）；
 * - search-provider.ts：搜索供应商契约（SearchProvider / SearchResult）；
 * - search-duckduckgo.ts：内置 DuckDuckGo HTML 搜索实现（默认供应商）。
 *
 * 模块依赖约束（002 2.2）：只依赖 node 内建，不 import 任何 core 符号。
 */
export * from './html';
export * from './domain';
export * from './context';
export * from './search-provider';
export * from './search-duckduckgo';
