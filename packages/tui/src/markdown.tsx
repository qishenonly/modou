/**
 * 流式 markdown 渲染（T-042）：代码块语法高亮、增量渲染不闪烁（帧节流）。
 *
 * ## 取舍说明（依赖体积 vs 正确性）
 *
 * markdown 解析与代码高亮都**自写最小实现、零新增依赖**，理由：
 * - 全量解析器（marked / micromark）产出 HTML / AST，还要再写一层 Ink 渲染器，
 *   对本版需求子集（标题 / 粗体 / 斜体 / 行内代码 / 列表 / 链接 / 围栏代码块）
 *   是杀鸡用牛刀，且流式下未闭合结构的处理方式不受我控制；
 * - 高亮器（highlight.js / shiki）：shiki 带 WASM 太重（TUI 不可取）；
 *   highlight.js 需逐语言注册 + 把 HTML 类名再映射回 Ink 颜色，两倍工作量；
 *   本版只需 ts/js/tsx/jsx/json/bash 五类常用语言的**终端可读**高亮，
 *   自写正则分词器足够，未知语言一律按纯文本（任务要求）。
 *
 * ## 流式不闪烁（帧节流）
 *
 * 高频 text_delta 若逐 token setState 会触发整屏重绘闪烁。这里把 delta 累积进
 * FrameThrottle 缓冲，每 frameMs（默认 50ms，任务要求 30–60ms）合并提交一次
 * setState；帧尾（turn_end / error）与卸载时立即 flush，保证终态完整。
 *
 * ## 流式未闭合结构
 *
 * 每帧对整个累积文本重新 parse 再渲染（无增量 AST，代码更简单、无状态漂移）：
 * - 未闭合围栏（``` 尚未遇到闭合）→ 余下文本按代码块渲染（GitHub 风格）；
 * - 未闭合加粗 / 斜体 / 行内代码 / 链接 → 标记按字面渲染，不崩、不闪断；
 * - 未闭合字符串（代码块内）→ 按字符串色渲染到行尾。
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Box, Text } from 'ink';

// ---------------------------------------------------------------------------
// 帧节流（增量渲染合并）
// ---------------------------------------------------------------------------

/** 帧节流窗口：任务要求 30–60ms 合并一次 delta 提交。 */
export const DEFAULT_FRAME_MS = 50;

/**
 * FrameThrottle：把高频 append 累积为缓冲，每 frameMs 经 sink 提交一次。
 *
 * 独立于 React 的纯逻辑类，便于单元测试（配合真实 setTimeout 即可确定性断言）。
 * - append：追加 delta 并入缓冲；首个 delta 启动帧定时器；
 * - commit：立即提交累积文本（幂等，帧尾 / 结束 / 卸载时调用）；
 * - pendingText：未提交缓冲（测试断言用）。
 */
export class FrameThrottle {
  private pending = '';
  private timerId: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sink: (text: string) => void,
    private readonly frameMs: number = DEFAULT_FRAME_MS,
  ) {}

  /** 追加一段 delta（只累计，不触发渲染）。 */
  append(delta: string): void {
    if (delta.length === 0) return;
    this.pending += delta;
    if (this.timerId === null) {
      this.timerId = setTimeout(() => this.commit(), this.frameMs);
    }
  }

  /** 立即提交累积文本（幂等）。 */
  commit(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.pending.length > 0) {
      const text = this.pending;
      this.pending = '';
      this.sink(text);
    }
  }

  /** 清空缓冲与计时器（新一轮回复从空开始）。 */
  clear(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.pending = '';
  }

  /** 尚未提交的累积文本。 */
  get pendingText(): string {
    return this.pending;
  }
}

/**
 * 流式文本 hook：App 消费 text_delta 的入口。
 * 返回 { text, append, flush, reset }：
 * - text：已提交的累积文本（每 frameMs 合并更新一次，供 Markdown 渲染）；
 * - append：追加一段 delta（帧节流，不立即渲染）；
 * - flush：立即提交缓冲并**返回本轮完整文本**（turn_end / error 时用于封存进
 *   会话历史；幂等，sink 同步执行所以返回值必然含最新累积）；
 * - reset：清空缓冲与已提交文本（新一轮回复从空开始）。
 */
export function useFrameThrottledText(frameMs: number = DEFAULT_FRAME_MS): {
  readonly text: string;
  readonly append: (delta: string) => void;
  readonly flush: () => string;
  readonly reset: () => void;
} {
  const [text, setText] = useState('');
  // 同步镜像的完整文本：sink 同步执行，flush 后立即读到最新值
  // （setText 是异步的，异步事件循环里不能依赖 state 变量）。
  const fullRef = useRef('');
  // FrameThrottle 只在首次渲染时构造一次（frameMs 按挂载期固定，App 用常量）。
  const throttleRef = useRef<FrameThrottle | null>(null);
  if (throttleRef.current === null) {
    throttleRef.current = new FrameThrottle((committed) => {
      fullRef.current += committed;
      setText(fullRef.current);
    }, frameMs);
  }
  // 卸载时提交残留缓冲（幂等，避免丢尾）。
  useEffect(() => {
    const throttle = throttleRef.current;
    return () => throttle?.commit();
  }, []);

  return {
    text,
    append: (delta) => throttleRef.current?.append(delta),
    flush: () => {
      throttleRef.current?.commit();
      return fullRef.current;
    },
    reset: () => {
      throttleRef.current?.clear();
      fullRef.current = '';
      setText('');
    },
  };
}

// ---------------------------------------------------------------------------
// 行内解析（粗体 / 斜体 / 行内代码 / 链接）
// ---------------------------------------------------------------------------

/** 行内文本片段（平铺模型：样式标记累加，扁平输出便于 Ink 逐段上色）。 */
export interface InlineRun {
  readonly text: string;
  /** 粗体 */
  readonly bold?: boolean;
  /** 斜体 */
  readonly italic?: boolean;
  /** 行内代码（反引号） */
  readonly code?: boolean;
  /** 链接文本（只显示文本，下划线弱化） */
  readonly link?: boolean;
}

/** 行内代码的显示色（与代码块内字符串色区分）。 */
const INLINE_CODE_COLOR = 'yellow';

/**
 * 解析行内标记为平铺片段。递归处理嵌套强调（**粗 *斜* 粗**），
 * 未闭合标记一律按字面文本，保证流式中途不闪断、不崩。
 */
export function parseInline(src: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let textBuf = '';

  const flushText = (): void => {
    if (textBuf.length > 0) {
      runs.push({ text: textBuf });
      textBuf = '';
    }
  };

  /** 在 from 之后找「独立」的单个强调标记（两侧不是同标记 → 不是 ** 的一部分）。 */
  const findSingleMarker = (ch: string, from: number): number => {
    for (let k = from; k < src.length; k++) {
      if (src[k] !== ch) continue;
      if (src[k - 1] === ch || src[k + 1] === ch) continue;
      return k;
    }
    return -1;
  };

  /** 提取强调片段：把父级样式叠到内层片段上（支持嵌套）。 */
  const wrapStyle = (
    inner: InlineRun[],
    style: Partial<Pick<InlineRun, 'bold' | 'italic'>>,
  ): void => {
    flushText();
    runs.push(...inner.map((run) => ({ ...run, ...style })));
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // 行内代码：连续反引号围栏，找同长反引号闭合
    if (ch === '`') {
      let j = i;
      while (j < src.length && src[j] === '`') j += 1;
      const fence = src.slice(i, j);
      const close = src.indexOf(fence, j);
      if (close !== -1) {
        flushText();
        runs.push({ text: src.slice(j, close), code: true });
        i = close + fence.length;
        continue;
      }
      // 未闭合：按字面文本继续
      textBuf += fence;
      i = j;
      continue;
    }

    // 链接 [文本](url)：只展示文本
    if (ch === '[') {
      const closeBracket = src.indexOf(']', i + 1);
      if (closeBracket !== -1 && src[closeBracket + 1] === '(') {
        const closeParen = src.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          flushText();
          runs.push({ text: src.slice(i + 1, closeBracket), link: true });
          i = closeParen + 1;
          continue;
        }
      }
    }

    // 强调：* / _（支持 **、*、*** 三种，递归解析内层）
    if (ch === '*' || ch === '_') {
      let j = i;
      while (j < src.length && src[j] === ch) j += 1;
      const count = j - i;
      const marker = src.slice(i, j);

      if (count >= 3) {
        const close = src.indexOf(marker, j);
        if (close !== -1) {
          wrapStyle(parseInline(src.slice(j, close)), {
            bold: true,
            italic: true,
          });
          i = close + count;
          continue;
        }
        // 未闭合 ***：按普通文本消费一个标记，余下 ** 交由下轮处理
        textBuf += ch;
        i += 1;
        continue;
      }
      if (count === 2) {
        const close = src.indexOf(marker, j);
        if (close !== -1) {
          wrapStyle(parseInline(src.slice(j, close)), { bold: true });
          i = close + 2;
          continue;
        }
        // 未闭合 **：按普通文本消费一个标记
        textBuf += ch;
        i += 1;
        continue;
      }
      // count === 1：斜体
      const close = findSingleMarker(ch, i + 1);
      if (close !== -1) {
        wrapStyle(parseInline(src.slice(i + 1, close)), { italic: true });
        i = close + 1;
        continue;
      }
    }

    textBuf += ch;
    i += 1;
  }

  flushText();
  return runs;
}

// ---------------------------------------------------------------------------
// 块解析（标题 / 段落 / 列表 / 围栏代码块）
// ---------------------------------------------------------------------------

export interface HeadingBlock {
  readonly type: 'heading';
  readonly level: number;
  readonly inline: readonly InlineRun[];
}

export interface ParagraphBlock {
  readonly type: 'paragraph';
  readonly inline: readonly InlineRun[];
}

export interface ListItemBlock {
  readonly inline: readonly InlineRun[];
  /** 嵌套子列表（collectList 构建期填充）。 */
  children: ListBlock[];
}

export interface ListBlock {
  readonly type: 'list';
  readonly ordered: boolean;
  /** 列表项（collectList 构建期填充）。 */
  items: ListItemBlock[];
}

export interface CodeBlock {
  readonly type: 'code';
  readonly lang: string;
  readonly code: string;
}

export type MarkdownBlock =
  HeadingBlock | ParagraphBlock | ListBlock | CodeBlock;

/** 围栏：``` 或 ~~~，后可跟语言。 */
const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

function matchFence(
  line: string,
): { char: string; length: number; lang: string } | null {
  const m = FENCE_RE.exec(line);
  if (m === null) return null;
  return { char: m[2][0], length: m[2].length, lang: m[3].trim() };
}

/** 闭合围栏：同字符、长度不小于开启围栏、只含该字符与空白。 */
function isClosingFence(
  line: string,
  char: string,
  minLength: number,
): boolean {
  const trimmed = line.trim();
  if (trimmed.length < minLength) return false;
  for (const c of trimmed) {
    if (c !== char) return false;
  }
  return true;
}

const HEADING_RE = /^(#{1,6})(?:[ \t]+)(.*)$/;

function matchHeading(line: string): { level: number; rest: string } | null {
  const m = HEADING_RE.exec(line);
  if (m === null) return null;
  return { level: m[1].length, rest: m[2].trim() };
}

/** 列表项：缩进 + 标记（- * + 或 `1.`）+ 内容。 */
const LIST_ITEM_RE = /^(\s*)([*+-]|\d+\.)([ \t]+)(.*)$/;

function matchListItem(
  line: string,
): { indent: number; ordered: boolean; rest: string } | null {
  const m = LIST_ITEM_RE.exec(line);
  if (m === null) return null;
  return { indent: m[1].length, ordered: /\d/.test(m[2]), rest: m[4].trim() };
}

function isListItem(line: string): boolean {
  return LIST_ITEM_RE.test(line);
}

/**
 * 收集连续列表项（含按缩进嵌套的子列表）。返回消费到的下一个行索引。
 * 简化：空行结束列表；不处理懒续行段落（项内多行文本）。
 */
function collectList(
  lines: readonly string[],
  start: number,
): { list: ListBlock; nextIndex: number } {
  const first = matchListItem(lines[start]);
  const root: ListBlock = {
    type: 'list',
    ordered: first?.ordered ?? false,
    items: [],
  };
  const stack: Array<{ indent: number; list: ListBlock }> = [
    { indent: first?.indent ?? 0, list: root },
  ];
  let lastItem: ListItemBlock | null = null;
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0) break;
    const item = matchListItem(line);
    if (item === null) break;

    // 缩进不小于当前层 → 弹出回退到更浅层（维护缩进栈）
    while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    const entry: ListItemBlock = {
      inline: parseInline(item.rest),
      children: [],
    };

    if (item.indent > top.indent && lastItem !== null) {
      // 更深缩进：挂在上一项的 children 下成为子列表
      const nested: ListBlock = {
        type: 'list',
        ordered: item.ordered,
        items: [],
      };
      lastItem.children = [...lastItem.children, nested];
      nested.items.push(entry);
      stack.push({ indent: item.indent, list: nested });
    } else {
      top.list.items.push(entry);
    }
    lastItem = entry;
    i += 1;
  }

  return { list: root, nextIndex: i };
}

/**
 * 把整段累积文本解析成块。每帧对整个文本重新解析（无增量 AST），
 * 未闭合围栏把余下文本按代码块渲染，天然适合流式。
 */
export function parseBlocks(text: string): MarkdownBlock[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    // 围栏代码块
    const fence = matchFence(line);
    if (fence !== null) {
      const codeLines: string[] = [];
      i += 1;
      while (
        i < lines.length &&
        !isClosingFence(lines[i], fence.char, fence.length)
      ) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 跳过闭合围栏
      blocks.push({
        type: 'code',
        lang: fence.lang,
        code: codeLines.join('\n'),
      });
      continue;
    }

    // 标题
    const heading = matchHeading(line);
    if (heading !== null) {
      blocks.push({
        type: 'heading',
        level: heading.level,
        inline: parseInline(heading.rest),
      });
      i += 1;
      continue;
    }

    // 列表
    if (isListItem(line)) {
      const { list, nextIndex } = collectList(lines, i);
      blocks.push(list);
      i = nextIndex;
      continue;
    }

    // 段落：收集到空行 / 围栏 / 标题 / 列表项为止
    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const l = lines[i];
      if (
        l.trim().length === 0 ||
        matchFence(l) !== null ||
        matchHeading(l) !== null ||
        isListItem(l)
      ) {
        break;
      }
      para.push(l);
      i += 1;
    }
    blocks.push({ type: 'paragraph', inline: parseInline(para.join('\n')) });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// 代码高亮（ts/js/tsx/jsx/json/bash；未知语言按纯文本）
// ---------------------------------------------------------------------------

/** 高亮片段：text + 可选终端安全色（Ink color prop 名）。 */
export interface HighlightToken {
  readonly text: string;
  readonly color?: string;
}

type CodeToken = HighlightToken;

/** 高亮配色：终端 16 色安全色，暗底可读。 */
const C = {
  keyword: 'yellow',
  string: 'green',
  number: 'magenta',
  comment: 'gray',
  type: 'cyan',
  fn: 'blue',
  property: 'cyan',
  variable: 'cyan',
} as const;

// --- TypeScript / JavaScript 系 -------------------------------------------------

const TS_KEYWORDS = new Set([
  'abstract',
  'as',
  'asserts',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'module',
  'namespace',
  'new',
  'of',
  'override',
  'package',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'satisfies',
  'set',
  'static',
  'super',
  'switch',
  'symbol',
  'throw',
  'try',
  'type',
  'typeof',
  'unique',
  'using',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'undefined',
]);

const TS_CONSTANTS = new Set(['true', 'false', 'null', 'NaN', 'Infinity']);

const TS_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'object',
  'any',
  'unknown',
  'never',
  'bigint',
  'Function',
  'Array',
  'Promise',
  'Record',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'Exclude',
  'Extract',
  'ReturnType',
  'Parameters',
  'Awaited',
]);

const TS_GLOBALS = new Set([
  'console',
  'Math',
  'JSON',
  'Date',
  'RegExp',
  'Error',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Symbol',
  'BigInt',
  'globalThis',
  'window',
  'document',
  'process',
  'Buffer',
  'fetch',
  'require',
  'exports',
  'module',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'structuredClone',
]);

/** 扫描 JSX 标签（rest 以 `<` 开头）。判定为标签才返回，否则 null（按普通字符处理）。 */
function scanJsxTag(
  rest: string,
): { tokens: CodeToken[]; consumed: number } | null {
  const after = rest[1] ?? '';
  if (after !== '/' && after !== '>' && !/[A-Za-z]/.test(after)) return null;

  const tokens: CodeToken[] = [];
  let i = 0;
  if (rest.startsWith('</')) {
    tokens.push({ text: '</' });
    i = 2;
  } else {
    tokens.push({ text: '<' });
    i = 1;
  }

  // 标签名（`<>` 碎片无名字）
  const name = /^[A-Za-z][A-Za-z0-9_.-]*/.exec(rest.slice(i));
  if (name !== null) {
    tokens.push({ text: name[0], color: C.fn });
    i += name[0].length;
  }

  // 属性区：直到 `>`（或 `/>`）；未闭合时消费到文末（流式安全）
  while (i < rest.length && rest[i] !== '>') {
    const ch = rest[i];
    if (/\s/.test(ch)) {
      tokens.push({ text: ch });
      i += 1;
      continue;
    }
    if (ch === '/' && rest[i + 1] === '>') {
      tokens.push({ text: '/>' });
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      const m = new RegExp(`^${q}(?:\\\\.|[^\\\\${q}])*${q}?`).exec(
        rest.slice(i),
      );
      const text = m?.[0] ?? q;
      tokens.push({ text, color: C.string });
      i += text.length;
      continue;
    }
    const attr = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(rest.slice(i));
    if (attr !== null) {
      tokens.push({ text: attr[0], color: C.property });
      i += attr[0].length;
      continue;
    }
    // JSX 表达式 { ... }：跳过平衡花括号（内部不做 JS 高亮，简化）
    if (ch === '{') {
      let depth = 0;
      let j = i;
      for (; j < rest.length; j++) {
        if (rest[j] === '{') depth += 1;
        else if (rest[j] === '}') {
          depth -= 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
      }
      tokens.push({ text: rest.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ text: ch });
    i += 1;
  }
  if (i < rest.length && rest[i] === '>') {
    tokens.push({ text: '>' });
    i += 1;
  }
  return { tokens, consumed: i };
}

/** TS/JS/TSX/JSX 分词器。jsx=true 时识别 JSX 标签（启发式，展示够用）。 */
function tokenizeTs(code: string, jsx: boolean): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;

  while (i < code.length) {
    const rest = code.slice(i);

    if (jsx && rest[0] === '<') {
      const tag = scanJsxTag(rest);
      if (tag !== null) {
        tokens.push(...tag.tokens);
        i += tag.consumed;
        continue;
      }
    }

    const ws = /^\s+/.exec(rest);
    if (ws !== null) {
      tokens.push({ text: ws[0] });
      i += ws[0].length;
      continue;
    }

    // 行注释
    if (rest.startsWith('//')) {
      const m = /^\/\/[^\n]*/.exec(rest);
      if (m !== null) {
        tokens.push({ text: m[0], color: C.comment });
        i += m[0].length;
        continue;
      }
    }
    // 块注释（未闭合时吃到文末，流式安全）
    if (rest.startsWith('/*')) {
      const m = /^\/\*[\s\S]*?\*\//.exec(rest) ?? /^\/\*[\s\S]*/.exec(rest);
      const text = m?.[0] ?? '/*';
      tokens.push({ text, color: C.comment });
      i += text.length;
      continue;
    }

    // 字符串（未闭合吃到行尾/文末）
    const q = rest[0];
    if (q === '"' || q === "'" || q === '`') {
      const re =
        q === '`'
          ? /^`(?:\\.|[^\\`])*`?/
          : new RegExp(`^${q}(?:\\\\.|[^\\\\${q}\\n])*${q}?`);
      const m = re.exec(rest);
      const text = m?.[0] ?? q;
      tokens.push({ text, color: C.string });
      i += text.length;
      continue;
    }

    // 数字
    const num = /^(?:0x[0-9a-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_.]*)/.exec(rest);
    if (num !== null) {
      tokens.push({ text: num[0], color: C.number });
      i += num[0].length;
      continue;
    }

    // 标识符：关键字 / 常量 / 类型 / 全局 / 函数调用
    const ident = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
    if (ident !== null) {
      const w = ident[0];
      let color: string | undefined;
      if (TS_KEYWORDS.has(w)) color = C.keyword;
      else if (TS_CONSTANTS.has(w)) color = C.number;
      else if (TS_TYPES.has(w) || /^[A-Z]/.test(w)) color = C.type;
      else if (TS_GLOBALS.has(w)) color = C.fn;
      const afterTrim = rest.slice(w.length).replace(/^\s+/, '');
      if (color === undefined && afterTrim.startsWith('(')) color = C.fn;
      tokens.push(color === undefined ? { text: w } : { text: w, color });
      i += w.length;
      continue;
    }

    tokens.push({ text: rest[0] });
    i += 1;
  }

  return tokens;
}

// --- JSON ----------------------------------------------------------------------

function tokenizeJson(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;

  while (i < code.length) {
    const rest = code.slice(i);

    const ws = /^\s+/.exec(rest);
    if (ws !== null) {
      tokens.push({ text: ws[0] });
      i += ws[0].length;
      continue;
    }

    if (rest[0] === '"') {
      const m = /^"(?:\\.|[^"\\\n])*"?/.exec(rest);
      const text = m?.[0] ?? '"';
      // 后随 `:`（跳过空白）的字符串是键 → 属性色
      const afterWs = rest.slice(text.length).match(/^\s*/)?.[0] ?? '';
      const nextCh = rest[text.length + afterWs.length] ?? '';
      tokens.push({ text, color: nextCh === ':' ? C.property : C.string });
      i += text.length;
      continue;
    }

    const num = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (num !== null) {
      tokens.push({ text: num[0], color: C.number });
      i += num[0].length;
      continue;
    }

    const kw = /^(?:true|false|null)/.exec(rest);
    if (kw !== null) {
      tokens.push({ text: kw[0], color: C.number });
      i += kw[0].length;
      continue;
    }

    tokens.push({ text: rest[0] });
    i += 1;
  }

  return tokens;
}

// --- Bash / Shell --------------------------------------------------------------

const BASH_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'select',
  'time',
]);

const BASH_BUILTINS = new Set([
  'echo',
  'cd',
  'export',
  'local',
  'read',
  'source',
  'exit',
  'return',
  'set',
  'unset',
  'alias',
  'unalias',
  'printf',
  'test',
  'shift',
  'declare',
  'eval',
  'exec',
  'let',
  'pwd',
  'pushd',
  'popd',
  'type',
  'trap',
  'wait',
  'umask',
  'break',
  'continue',
  'command',
  'builtin',
  'true',
  'false',
  'jobs',
  'fg',
  'bg',
  'kill',
  'mapfile',
  'readarray',
]);

function tokenizeBash(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;

  while (i < code.length) {
    const rest = code.slice(i);

    const ws = /^\s+/.exec(rest);
    if (ws !== null) {
      tokens.push({ text: ws[0] });
      i += ws[0].length;
      continue;
    }

    if (rest.startsWith('#')) {
      const m = /^#[^\n]*/.exec(rest);
      if (m !== null) {
        tokens.push({ text: m[0], color: C.comment });
        i += m[0].length;
        continue;
      }
    }

    // 单引号字符串（未闭合吃到文末）
    if (rest[0] === "'") {
      const m = /^'(?:[^'\\\n]|\\.)*'?/.exec(rest);
      const text = m?.[0] ?? "'";
      tokens.push({ text, color: C.string });
      i += text.length;
      continue;
    }
    // 双引号字符串（含 $ 展开整体按字符串色，简化）
    if (rest[0] === '"') {
      const m = /^"(?:[^"\\\n]|\\.)*"?/.exec(rest);
      const text = m?.[0] ?? '"';
      tokens.push({ text, color: C.string });
      i += text.length;
      continue;
    }

    // 变量：$NAME / ${...} / $? / $@ 等
    if (rest[0] === '$') {
      const m =
        /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]*\}|[0-9?@$*#-])/.exec(rest) ??
        /^\$/.exec(rest);
      const text = m?.[0] ?? '$';
      tokens.push({ text, color: C.variable });
      i += text.length;
      continue;
    }

    const num = /^\d[\d.]*/.exec(rest);
    if (num !== null) {
      tokens.push({ text: num[0], color: C.number });
      i += num[0].length;
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (word !== null) {
      const w = word[0];
      let color: string | undefined;
      if (BASH_KEYWORDS.has(w)) color = C.keyword;
      else if (BASH_BUILTINS.has(w)) color = C.fn;
      tokens.push(color === undefined ? { text: w } : { text: w, color });
      i += w.length;
      continue;
    }

    // 选项旗标：--flag / -x
    const flag = /^--?[A-Za-z0-9][A-Za-z0-9_-]*/.exec(rest);
    if (flag !== null) {
      tokens.push({ text: flag[0], color: C.fn });
      i += flag[0].length;
      continue;
    }

    tokens.push({ text: rest[0] });
    i += 1;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// 高亮入口：整段代码 → 按行分组的 token
// ---------------------------------------------------------------------------

/**
 * 按语言对代码段高亮，返回逐行 token 数组。
 * 支持 ts / js / tsx / jsx / json / bash(sh/shell/zsh)；未知语言返回纯文本（无颜色）。
 */
export function highlight(code: string, lang?: string): HighlightToken[][] {
  const normalized = (lang ?? '').trim().toLowerCase();
  let tokens: CodeToken[];

  if (normalized === 'json') {
    tokens = tokenizeJson(code);
  } else if (
    normalized === 'bash' ||
    normalized === 'sh' ||
    normalized === 'shell' ||
    normalized === 'zsh'
  ) {
    tokens = tokenizeBash(code);
  } else if (normalized === 'tsx' || normalized === 'jsx') {
    tokens = tokenizeTs(code, true);
  } else if (
    normalized === 'ts' ||
    normalized === 'js' ||
    normalized === 'typescript' ||
    normalized === 'javascript' ||
    normalized === 'mjs' ||
    normalized === 'cjs'
  ) {
    tokens = tokenizeTs(code, false);
  } else {
    tokens = code.length > 0 ? [{ text: code }] : [];
  }

  return splitTokensByLine(tokens);
}

/** 把含 `\n` 的 token 流按行切开（渲染时逐行上色、逐行换行）。 */
function splitTokensByLine(tokens: readonly CodeToken[]): CodeToken[][] {
  const lines: CodeToken[][] = [];
  let current: CodeToken[] = [];
  for (const token of tokens) {
    const parts = token.text.split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) {
        lines.push(current);
        current = [];
      }
      if (parts[p].length > 0) {
        current.push({ text: parts[p], color: token.color });
      }
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

// ---------------------------------------------------------------------------
// Markdown 组件（Ink 渲染）
// ---------------------------------------------------------------------------

export interface MarkdownProps {
  /** 累积的 markdown 文本（流式中途未闭合也安全渲染）。 */
  readonly text: string;
}

/** 把行内片段渲染进一个 Text（父级样式叠加，支持嵌套强调）。 */
function renderInlineRuns(
  runs: readonly InlineRun[],
  key: string,
): ReactElement {
  return (
    <Text key={key}>
      {runs.map((run, idx) => (
        <Text
          key={idx}
          bold={run.bold}
          italic={run.italic}
          color={run.code ? INLINE_CODE_COLOR : undefined}
          dimColor={run.link}
          underline={run.link}
        >
          {run.text}
        </Text>
      ))}
    </Text>
  );
}

/** 渲染一个列表块（含嵌套子列表）。 */
function renderList(list: ListBlock, key: string): ReactElement {
  return (
    <Box key={key} flexDirection="column">
      {list.items.map((item, idx) => {
        const marker = list.ordered ? `${idx + 1}. ` : '• ';
        return (
          <Box key={idx} flexDirection="row">
            <Text>{marker}</Text>
            <Box flexDirection="column" flexGrow={1}>
              {renderInlineRuns(item.inline, `inline-${idx}`)}
              {item.children.map((child, cidx) =>
                renderList(child, `child-${idx}-${cidx}`),
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** 渲染一个块（块之间空一行，代码块加圆角边框与语言标注）。 */
function renderBlock(block: MarkdownBlock, index: number): ReactElement {
  const topMargin = index === 0 ? 0 : 1;

  switch (block.type) {
    case 'heading':
      return (
        <Box key={`b${index}`} marginTop={topMargin}>
          <Text bold color="cyan">
            {renderInlineRuns(
              [{ text: '#'.repeat(block.level) + ' ' }, ...block.inline],
              'h',
            )}
          </Text>
        </Box>
      );
    case 'paragraph':
      return (
        <Box key={`b${index}`} marginTop={topMargin}>
          {renderInlineRuns(block.inline, 'p')}
        </Box>
      );
    case 'list':
      return (
        <Box key={`b${index}`} marginTop={topMargin}>
          {renderList(block, 'list')}
        </Box>
      );
    case 'code':
      return (
        <Box
          key={`b${index}`}
          marginTop={topMargin}
          flexDirection="column"
          borderStyle="round"
          paddingLeft={1}
          paddingRight={1}
        >
          {block.lang.length > 0 && <Text dimColor>{block.lang}</Text>}
          {highlight(block.code, block.lang).map((line, li) => (
            <Text key={li}>
              {line.map((tok, ti) => (
                <Text key={ti} color={tok.color}>
                  {tok.text}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      );
  }
}

/**
 * Markdown 组件：把累积文本渲染为 Ink 结构。
 * 每帧整段重解析（useMemo 缓存），帧节流由上层 useFrameThrottledText 保证。
 */
export function Markdown({ text }: MarkdownProps): ReactElement {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => renderBlock(block, index))}
    </Box>
  );
}
