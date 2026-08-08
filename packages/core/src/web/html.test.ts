import { describe, expect, test } from 'bun:test';
import { decodeEntities, extractTitle, htmlToText } from './html';

/**
 * HTML → 纯文本（0.17.0 T-171 WebFetch）：零依赖正则转换。
 * 覆盖：script/style 剔除、块级换行、链接转 text(url)、实体解码、空白归一。
 */
describe('htmlToText', () => {
  test('剔除 script/style 内容（不是正文）', () => {
    const html = `<html><head><script>var x = "<p>不是正文</p>";</script>
<style>p { color: red }</style></head><body><p>真实正文</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('真实正文');
    expect(text).not.toContain('不是正文');
    expect(text).not.toContain('var x');
    expect(text).not.toContain('color');
  });

  test('块级标签换行 + 空白归一', () => {
    const html = `<div><h1>标题</h1><p>第一段。</p><p>第二段。</p></div>`;
    const text = htmlToText(html);
    expect(text).toContain('标题');
    expect(text).toContain('第一段。');
    expect(text).toContain('第二段。');
    const lines = text.split('\n');
    expect(lines.filter((l) => l.length > 0)).toHaveLength(3);
  });

  test('li 列表 → 项目符号行', () => {
    const html = `<ul><li>甲</li><li>乙</li></ul>`;
    const text = htmlToText(html);
    expect(text).toContain('- 甲');
    expect(text).toContain('- 乙');
  });

  test('链接转 text (url)', () => {
    const html = `<p>文档见 <a href="https://example.com/docs">官方文档</a>。</p>`;
    const text = htmlToText(html);
    expect(text).toContain('官方文档 (https://example.com/docs)');
    expect(text).toContain('文档见');
  });

  test('实体解码：命名实体 + 数字实体', () => {
    expect(decodeEntities('a &amp; b &lt;tag&gt; &quot;q&quot;')).toBe(
      'a & b <tag> "q"',
    );
    expect(decodeEntities('&#39; &#x27; &#65;')).toBe("' ' A");
    expect(decodeEntities('未知 &unknown; 保留')).toBe('未知 &unknown; 保留');
  });

  test('纯文本（非 HTML）原样返回', () => {
    const text = '普通文本\n第二行';
    expect(htmlToText(text)).toBe(text);
  });

  test('br/hr → 换行', () => {
    const html = 'a<br>b<hr>c';
    const text = htmlToText(html);
    expect(text.split('\n').filter((l) => l.length > 0)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('extractTitle', () => {
  test('取 <title> 内容', () => {
    expect(
      extractTitle(
        '<html><head><title>  我的页面 &amp; 标题 </title></head></html>',
      ),
    ).toBe('我的页面 & 标题');
  });

  test('无 title 返回 undefined', () => {
    expect(extractTitle('<html><body>x</body></html>')).toBeUndefined();
  });
});
