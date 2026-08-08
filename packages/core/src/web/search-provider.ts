/**
 * 搜索供应商契约（0.17.0 T-172 WebSearch）。
 *
 * 放在 web 层（而非 tools 层）：SearchProvider 是搜索能力的领域接口，内置
 * DuckDuckGo 实现（web/search-duckduckgo.ts）与本模块同层，tools/impl/websearch.ts
 * 单向消费（tools → web 合法，002 2.2；web 内部不反向依赖 tools）。
 */

/** 一条搜索结果（供应商返回的原始形态）。 */
export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** 搜索供应商（可注入后端；内置 DuckDuckGo 满足本接口）。 */
export interface SearchProvider {
  /** 按查询词执行一次搜索。失败抛错（工具侧归一为错误即数据）。 */
  search(
    query: string,
    opts?: { readonly maxResults?: number; readonly signal?: AbortSignal },
  ): Promise<readonly SearchResult[]>;
}
