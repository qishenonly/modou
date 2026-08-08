/**
 * HTML → 纯文本（0.17.0 T-171 WebFetch）：抓回的网页正文转成模型可读的文本。
 *
 * 刻意不引入解析器依赖（不引入 cheerio / htmlparser2——内核小而稳，002 一），
 * 用正则 + 状态扫描做「够用」的转换：真实网页里 80% 的噪音是 script/style 块
 * 与标签本身，这两类清掉后剩余文本基本可读。局限（诚实声明）：
 * - 不解析 CSS 布局（table 转行的语义是启发式的）；
 * - 不处理嵌套复杂标签的边界情况（如 `<pre>` 内换行保留）；
 * - 字体图标 / canvas / iframe 内容不可见（本就不是正文）。
 *
 * 输出约定：每个块级元素后换行；链接转成 `text (url)` 形态（来源可核对）；
 * 连续空行压缩为单个空行；实体解码（HTML 命名实体 + 十进制/十六进制数字实体）。
 *
 * 模块依赖约束（002 2.2）：web 属于工具面扩展，只依赖 node 内建，不 import
 * 任何 core 符号（tools/impl/webfetch.ts 消费本模块，tools 边界保持只依赖 zod）。
 */

/** 块级闭合标签：闭合后追加换行（正文的可读分块边界）。 */
const BLOCK_CLOSERS =
  /<\/(p|div|section|article|header|footer|main|aside|li|ul|ol|table|tr|h[1-6]|blockquote|pre|figure|figcaption)>/gi;

/** 自闭合 / 单标签换行点：br / hr / li 起始。 */
const SELF_CLOSING = /<(br|hr)\s*\/?>/gi;
const LI_START = /<li[^>]*>/gi;

/** 整块剔除：脚本 / 样式 / 模板 / 注释——内容不是正文。 */
const STRIP_BLOCKS =
  /<(script|style|noscript|template|svg|head|title)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi;

/** 链接标签：`<a href="url" ...>text</a>` → `text (url)`（相对地址留原文）。 */
const ANCHOR = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

/** 其余全部标签（含属性）剥除。 */
const STRIP_TAGS = /<[^>]+>/g;

/** 命名实体表（HTML5 常用子集；数字实体单独处理）。 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  bull: '•',
  middot: '·',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  para: '§',
  times: '×',
  divide: '÷',
  minus: '−',
  permiil: '‰',
  laquo: '«',
  raquo: '»',
  nbsp2: ' ',
};

/**
 * 解码 HTML 实体：命名实体（&amp; 等）+ 数字实体（&#39; / &#x27;）。
 * 未识别的实体原样保留（不吞字符）。
 */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith('#')) {
        const hex = body.startsWith('#x') || body.startsWith('#X');
        const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return match;
          }
        }
        return match;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/** 折叠行内空白（制表符 / 连续空格 → 单个空格；保留换行）。 */
function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\f\v]+/g, ' ');
}

/** HTML → 文本。输入可以是完整 HTML 文档或片段；非 HTML（纯文本）原样返回。 */
export function htmlToText(html: string): string {
  let text = html;
  // 1. 整块剔除（先于标签剥除——script/style 内容里的 < 不是标签）
  text = text.replace(STRIP_BLOCKS, ' ');
  // 2. 块级闭合 → 换行
  text = text.replace(BLOCK_CLOSERS, '\n');
  // 3. br/hr → 换行；li 起始 → 换行 + 项目符号
  text = text.replace(SELF_CLOSING, '\n');
  text = text.replace(LI_START, '\n- ');
  // 4. 链接 → `text (url)`（内部标签在下一步剥除）
  text = text.replace(ANCHOR, (_whole, href: string, label: string) => {
    const trimmed = label.trim();
    return trimmed.length > 0 ? `${trimmed} (${href})` : `(${href})`;
  });
  // 5. 剥除剩余标签
  text = text.replace(STRIP_TAGS, '');
  // 6. 实体解码
  text = decodeEntities(text);
  // 7. 空白归一：每行折叠行内空白；空行压缩为单个空行
  const lines = text
    .split('\n')
    .map((line) => collapseWhitespace(line).trim())
    .filter((line, index, arr) => {
      // 压缩连续空行：保留行非空，或保留「前一行非空」的空行（段落边界）
      if (line.length > 0) return true;
      return index === 0 ? false : arr[index - 1].length > 0;
    });
  return lines.join('\n').trim();
}

/** 取网页标题（<title> 内容；无标题返回 undefined）。 */
export function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) return undefined;
  const title = htmlToText(match[1]).trim();
  return title.length > 0 ? title : undefined;
}
