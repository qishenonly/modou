import { decodeEntities, htmlToText } from './html';
import type { SearchProvider, SearchResult } from './search-provider';

/**
 * 内置 DuckDuckGo 搜索供应商（0.17.0 T-172 WebSearch）。
 *
 * 走 DuckDuckGo 的 HTML 端点（html.duckduckgo.com/html/?q=…）——无需 API Key、
 * 无需配置即可联网搜索（默认供应商；`never` 策略 / 注入后端可替换）。
 *
 * 解析：零依赖正则提取结果块（class="result__a" 锚 = 标题 + 链接，
 * class="result__snippet" 锚 = 摘要），按出现顺序配对；链接是 DDG 的跳转
 * URL（//duckduckgo.com/l/?uddg=<编码目标>）——提取 uddg 参数并解码为真实
 * 目标（还原原始 URL 供模型 / 用户核对）。标题 / 摘要经 htmlToText 清洗
 * （实体解码 + 标签剥除）。
 *
 * 依赖注入：fetchImpl 可注入（测试离线 stub 覆盖解析）；超时可配。
 * 模块依赖约束（002 2.2）：只依赖 node 内建与本模块。
 */

/** DuckDuckGo 供应商配置。 */
export interface DuckDuckGoConfig {
  /** 搜索超时（毫秒；缺省 10s）。 */
  readonly timeoutMs?: number;
  /** fetch 实现（缺省全局 fetch；测试注入 stub）。 */
  readonly fetchImpl?: typeof fetch;
}

/** 结果链接锚（class 含 result__a）：捕获 href 与标题 HTML。 */
const RESULT_LINK =
  /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
/** 摘要锚（class 含 result__snippet）：捕获摘要 HTML。 */
const SNIPPET =
  /<a\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;

/** 从 DDG 跳转 URL 提取真实目标（uddg 参数解码；无则原样返回）。 */
function realTarget(href: string): string {
  let resolved = href;
  if (resolved.startsWith('//')) resolved = `https:${resolved}`;
  try {
    const url = new URL(resolved);
    const target = url.searchParams.get('uddg');
    if (target !== null && target.length > 0) return target;
    return resolved;
  } catch {
    return resolved;
  }
}

/** 解析 DDG HTML 搜索页：提取标题 / 链接 / 摘要三元组（按出现顺序配对）。 */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const titles: Array<{ href: string; html: string }> = [];
  for (const match of html.matchAll(RESULT_LINK)) {
    titles.push({ href: match[1], html: match[2] });
  }
  const snippets: string[] = [];
  for (const match of html.matchAll(SNIPPET)) {
    snippets.push(match[1]);
  }
  return titles.map((title, index) => ({
    title: htmlToText(title.html).trim(),
    url: realTarget(title.href),
    snippet: htmlToText(snippets[index] ?? '').trim(),
  }));
}

/** 构造 DuckDuckGo 搜索供应商（满足 SearchProvider 接口）。 */
export function createDuckDuckGoProvider(
  config: DuckDuckGoConfig = {},
): SearchProvider {
  return {
    async search(query, opts) {
      const fetchImpl = config.fetchImpl ?? globalThis.fetch;
      const timeoutMs = config.timeoutMs ?? 10_000;
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: {
            Accept:
              'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          },
          signal: opts?.signal ?? AbortSignal.timeout(timeoutMs),
        });
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'TimeoutError') {
          throw new Error(`搜索超时（超过 ${timeoutMs}ms，已中止）`);
        }
        const reason =
          caught instanceof Error ? caught.message : String(caught);
        throw new Error(`网络错误：${reason}`);
      }
      if (!response.ok) {
        throw new Error(
          `搜索服务返回 HTTP ${response.status} ${response.statusText}`,
        );
      }
      const raw = await response.text();
      const results = parseDuckDuckGoHtml(raw).filter(
        (result) => result.title.length > 0 || result.url.length > 0,
      );
      const limit = opts?.maxResults ?? 5;
      return results.slice(0, limit);
    },
  };
}

/** 直接解码的实体辅助（parse 复用 html 模块的 decodeEntities；此处 re-export 供测试）。 */
export { decodeEntities };
