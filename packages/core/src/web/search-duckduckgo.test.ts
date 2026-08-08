import { describe, expect, test } from 'bun:test';
import { parseDuckDuckGoHtml } from './search-duckduckgo';

/**
 * 内置 DuckDuckGo 搜索解析（0.17.0 T-172）：HTML 端点响应 → 结构化结果。
 * 覆盖：标题/链接/摘要提取、跳转 URL 还原、无结果、实体解码。
 */
describe('parseDuckDuckGoHtml', () => {
  const SAMPLE = `<html><body>
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a"
             href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs&amp;rut=abc">Bun 官方文档</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs&amp;rut=abc">Bun 是一个快速的全栈 JavaScript 运行时。</a>
      </div>
    </div>
    <div class="result results_links results_links_deep web-result">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a"
             href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=def">Example &amp; Co</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=def">A snippet with &lt;b&gt;bold&lt;/b&gt; text.</a>
      </div>
    </div>
  </body></html>`;

  test('提取标题 / 链接（跳转 URL 还原为真实目标）/ 摘要', () => {
    const results = parseDuckDuckGoHtml(SAMPLE);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Bun 官方文档',
      url: 'https://bun.sh/docs',
      snippet: 'Bun 是一个快速的全栈 JavaScript 运行时。',
    });
    expect(results[1].url).toBe('https://example.com/a');
    // 实体解码：标题里的 &amp; → &；摘要里的 &lt;b&gt;（转义标签）→ 字面 <b>
    expect(results[1].title).toBe('Example & Co');
    expect(results[1].snippet).toBe('A snippet with <b>bold</b> text.');
  });

  test('无结果返回空数组', () => {
    expect(parseDuckDuckGoHtml('<html><body>no results</body></html>')).toEqual(
      [],
    );
  });

  test('非 DDG 跳转链接（普通 href）原样保留', () => {
    const html = `<a class="result__a" href="https://direct.example.com">直接链接</a>`;
    const results = parseDuckDuckGoHtml(html);
    expect(results[0].url).toBe('https://direct.example.com');
  });
});
