import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext, ToolOutcome } from '../types';
import { writeFileAtomically } from './write';

/**
 * Edit 工具（T-031）：`old_string → new_string` 字符串替换原语（ADR 0006）。
 *
 * 设计依据（docs/design/002-architecture.md 5.2 / 5.3 / 5.4）：
 * - 唯一匹配：old_string 必须在文件中出现且恰好一次，替换才执行；出现多次 →
 *   列出各匹配位置（行号 + 上下文）并提示「用 replace_all 或补充更多上下文使
 *   old_string 唯一」；出现 0 次 → 相似片段诊断（见下），让模型一次修好；
 * - **错误信息质量比成功路径更重要**（002 5.3 最典型的例子）：0 次匹配时不是
 *   回一句「未找到」让模型瞎猜，而是用「行级 n-gram 粗筛 + 编辑距离精评」找出
 *   最相近片段，报告其行号、片段内容与差异类型（缩进 / 换行 / 标点 / 大小写 /
 *   字符），模型据此修正 old_string 即可命中；
 * - 防盲写：与 Write（T-030）一致——目标文件在本会话须已被 Read
 *   （ctx.readFiles，realpath 归一化），否则拒绝并提示先 Read；
 * - 错误即数据：文件不存在 / 目录 / 非常规文件 / 无权限 / 过大 / 二进制 /
 *   old_string 为空，全部返回 `ok:false` 的可诊断文本回喂模型自纠，不抛异常；
 * - 原子写：复用 write.ts 的 writeFileAtomically（同目录临时文件 + rename，
 *   保留原 mode），失败不留半个文件。
 *
 * 实现要点：
 * 1) 匹配用非重叠 indexOf 扫描，统计全部出现次数与位置；行号由预计算的行起始
 *    偏移表二分查找得出（单遍 O(文件字符数)）；
 * 2) 0 次匹配的相似片段搜索 = 粗筛 + 精评两阶段：先把 old_string 切成字符
 *    n-gram 集合，对每一行统计命中数取前 N 行（O(文件字符数)，快），再对候选行
 *    及其前/后 1 行构成的窗口与 old_string 做编辑距离相似度评分（候选数受限，
 *    比较长度截断，量级可控）；按「空白归一后的相似度」为主键选最相近窗口；
 * 3) 无相近片段（相似度低于阈值）时不硬凑「最相近」，如实说明「没有相近内容」，
 *    避免误导模型去改无关代码。
 */

/** Edit 大文件保护：需整读文件做精确匹配与替换，超过即拒绝（建议 Grep 定位 / 分块处理）。 */
export const EDIT_MAX_BYTES = 8 * 1024 * 1024;
/**
 * payload 里 diff 展示字段（old_string / new_string）的单侧字符上限：
 * 超出即截断头部，防止超长编辑把事件流撑爆。截断发生在 payload 侧——前端拿到的
 * diff 只是给人看的，截断只影响展示粒度，不影响回喂模型的 forModel 与真实文件。
 */
export const EDIT_PAYLOAD_DIFF_MAX = 2000;
/** 多匹配时最多列出的位置数（超出只声明剩余数量，不穷举）。 */
export const EDIT_AMBIGUOUS_LIST_MAX = 5;
/** 相似片段粗筛：每行 n-gram 命中数封顶（防超长行把 score 撑爆）。 */
const EDIT_NGRAM_HIT_CAP = 50;
/** 相似片段粗筛：按 n-gram 命中数保留的候选行数。 */
const EDIT_SCAN_CANDIDATES = 30;
/** 相似片段精评：编辑距离比较的字符长度上限（两端都截断；超长片段差异集中在头部）。 */
const EDIT_DIFF_CAP = 400;
/** 相似片段判定阈值：相似度低于它即视为「无相近片段」，不再展示误导性候选。 */
const EDIT_SIMILARITY_FLOOR = 0.35;
/** 展示用：匹配片段前/后各带的上下文行数。 */
const EDIT_CONTEXT_LINES = 1;
/** 展示用：单行最大字符数，超出裁剪并加省略号。 */
const EDIT_DISPLAY_LINE_MAX = 160;

/** Edit 工具参数 schema（zod）：path / old_string / new_string 必填；replace_all 可选。 */
export const editSchema = z.object({
  path: z.string().min(1, 'path 不能为空字符串'),
  old_string: z.string().min(1, 'old_string 不能为空字符串'),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

export type EditArgs = z.infer<typeof editSchema>;

/** Edit 结构化载荷（成功与错误共用：错误时 error / suggestion 存在，matches 仅在需要时）。 */
export interface EditPayload {
  readonly path: string;
  /** 本次是否真的做了替换（未匹配 / 匹配不唯一 / 出错时 false）。 */
  readonly replaced: boolean;
  /** old_string 在文件中的出现次数（0 = 未匹配；>1 = 匹配不唯一）。 */
  readonly occurrenceCount: number;
  /** 匹配位置列表（行号 + 首行文本；匹配不唯一时存在，最多 EDIT_AMBIGUOUS_LIST_MAX 条）。 */
  readonly matches?: ReadonlyArray<{
    readonly line: number;
    readonly context: string;
  }>;
  /** 替换后的字节数（替换成功时存在）。 */
  readonly newBytes?: number;
  /** 错误码（失败时存在）。 */
  readonly error?:
    | 'not_found'
    | 'is_directory'
    | 'not_regular_file'
    | 'permission_denied'
    | 'too_large'
    | 'binary'
    | 'old_string_empty'
    | 'not_read_before_edit'
    | 'no_match'
    | 'ambiguous_match'
    | 'read_failed'
    | 'write_failed'
    | 'interrupted';
  /** 最相近片段诊断（no_match 且存在相近内容时）。 */
  readonly suggestion?: {
    readonly line: number;
    readonly snippet: string;
    readonly difference: string;
  };
  /** 被替换的原文（diff 展示用，成功替换时存在；超长按字符截断，见 EDIT_PAYLOAD_DIFF_MAX）。 */
  readonly old_string?: string;
  /** 替换后的新文（diff 展示用，成功替换时存在）。 */
  readonly new_string?: string;
}

/** 工具选项：允许测试与特化场景覆盖默认阈值。 */
export interface EditToolOptions {
  /** 大文件保护上限（字节）。默认 EDIT_MAX_BYTES。 */
  readonly maxBytes?: number;
}

/** 解析后的运行时选项（默认值已展开）。 */
interface EditRuntimeOptions {
  readonly maxBytes: number;
}

/** 一处匹配：偏移 + 行号 + 首行文本。 */
interface MatchPosition {
  /** 匹配在全文中的字符偏移（与 indexOf 一致，UTF-16 下标）。 */
  readonly index: number;
  /** 匹配起点所在行（1-based）。 */
  readonly line: number;
  /** 匹配起点所在行的全文（展示时再裁剪）。 */
  readonly lineText: string;
}

/** 相似片段诊断结果。 */
interface Suggestion {
  /** 候选窗口起始行（1-based）。 */
  readonly line: number;
  /** 展示用片段（带行号与上下文行）。 */
  readonly snippet: string;
  /** 差异类型说明。 */
  readonly difference: string;
}

/** 失败结果（错误即数据）：payload 携带结构化错误码供前端渲染。 */
function fail(forModel: string, payload?: unknown): ToolOutcome {
  return payload === undefined
    ? { ok: false, forModel }
    : { ok: false, forModel, payload };
}

/** 从 fs 异常里取错误码（如 ENOENT / EACCES）。 */
function errorCode(caught: unknown): string | undefined {
  if (typeof caught !== 'object' || caught === null || !('code' in caught)) {
    return undefined;
  }
  const code = (caught as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** 字节数的人类可读格式。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} 字节`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 把 stat / 读取阶段的 fs 错误映射为可诊断文本（路径 + 建议）。 */
function fileErrorOutcome(path: string, caught: unknown): ToolOutcome {
  const code = errorCode(caught);
  const message = caught instanceof Error ? caught.message : String(caught);

  if (code === 'ENOENT') {
    return fail(
      `文件 "${path}" 不存在（ENOENT）。请核对路径：相对路径相对当前工作目录解析，` +
        `也可使用绝对路径；Edit 只能修改已有文件，新建文件请用 Write。可先用 Glob 确认文件是否已创建。`,
      { path, replaced: false, occurrenceCount: 0, error: 'not_found' },
    );
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return fail(
      `读取 "${path}" 被拒绝：权限不足（${code}）。请确认该文件可读（含所在目录的遍历权限）后重试。`,
      { path, replaced: false, occurrenceCount: 0, error: 'permission_denied' },
    );
  }
  return fail(
    `读取 "${path}" 失败（${String(code ?? '未知错误')}）：${message}`,
    {
      path,
      replaced: false,
      occurrenceCount: 0,
      error: 'read_failed',
    },
  );
}

/** 把写回阶段的 fs 错误映射为可诊断文本。 */
function writeErrorOutcome(
  path: string,
  caught: unknown,
  occurrenceCount: number,
): ToolOutcome {
  const code = errorCode(caught);
  const message = caught instanceof Error ? caught.message : String(caught);
  if (code === 'EACCES' || code === 'EPERM') {
    return fail(
      `写入 "${path}" 被拒绝：权限不足（${code}）。请确认目标文件与其所在目录具有写入权限后重试。`,
      { path, replaced: false, occurrenceCount, error: 'permission_denied' },
    );
  }
  return fail(
    `写入 "${path}" 失败（${String(code ?? '未知错误')}）：${message}`,
    {
      path,
      replaced: false,
      occurrenceCount,
      error: 'write_failed',
    },
  );
}

/** 预计算每行的起始字符偏移（第 i 行从 lineStarts[i] 开始，i 从 0）。 */
function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** 二分查找：字符偏移所在的行号（1-based）。 */
function lineNumberAt(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** 取偏移所在行的全文（剥掉行尾 \r\n）。 */
function lineTextAt(
  content: string,
  lineStarts: number[],
  offset: number,
): string {
  const lineNo = lineNumberAt(lineStarts, offset) - 1;
  const start = lineStarts[lineNo];
  const end =
    lineNo + 1 < lineStarts.length ? lineStarts[lineNo + 1] : content.length;
  return content.slice(start, end).replace(/\r?\n$/, '');
}

/** 非重叠扫描 old_string 在 content 中的所有出现位置（语义与 String.replaceAll 一致）。 */
function findAllMatches(content: string, oldString: string): MatchPosition[] {
  const lineStarts = computeLineStarts(content);
  const out: MatchPosition[] = [];
  let idx = 0;
  for (;;) {
    const found = content.indexOf(oldString, idx);
    if (found === -1) break;
    out.push({
      index: found,
      line: lineNumberAt(lineStarts, found),
      lineText: lineTextAt(content, lineStarts, found),
    });
    idx = found + oldString.length; // 非重叠：从匹配结束处之后继续找
  }
  return out;
}

/** 字符 n-gram 索引（n 取 min(3, 文本长度)；短串直接用整串）。 */
interface NgramIndex {
  readonly n: number;
  readonly set: Set<string>;
}

function buildNgramIndex(text: string): NgramIndex {
  const n = Math.min(3, text.length);
  const set = new Set<string>();
  if (text.length <= n) {
    set.add(text);
    return { n: Math.max(1, n), set };
  }
  for (let i = 0; i + n <= text.length; i++) set.add(text.slice(i, i + n));
  return { n, set };
}

/** 统计一行与 old_string 的 n-gram 命中数（封顶，防超长行撑爆）。 */
function ngramHits(line: string, index: NgramIndex): number {
  const { n, set } = index;
  if (line.length < n) return 0;
  let hits = 0;
  for (let i = 0; i + n <= line.length; i++) {
    if (set.has(line.slice(i, i + n))) {
      hits++;
      if (hits >= EDIT_NGRAM_HIT_CAP) break;
    }
  }
  return hits;
}

/** 取命中数最高的 k 行下标（平局按行号小者优先，确定性）。 */
function topIndices(scores: number[], k: number): number[] {
  return scores
    .map((score, index) => ({ score, index }))
    .sort((x, y) => y.score - x.score || x.index - y.index)
    .slice(0, k)
    .map((entry) => entry.index);
}

/** 标准 Levenshtein 编辑距离（全量 DP，输入已按 EDIT_DIFF_CAP 截断）。 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // 让 s1 是较短串，减少 DP 宽度
  const [s1, s2] = m <= n ? [a, b] : [b, a];
  const len1 = s1.length;
  const len2 = s2.length;
  let prev = new Uint32Array(len1 + 1);
  let curr = new Uint32Array(len1 + 1);
  for (let j = 0; j <= len1; j++) prev[j] = j;
  for (let i = 1; i <= len2; i++) {
    curr[0] = i;
    for (let j = 1; j <= len1; j++) {
      const cost = s2.charCodeAt(i - 1) === s1.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[len1];
}

/** 归一相似度：1 - 编辑距离 / 较长串长度（两端先截到 EDIT_DIFF_CAP）。 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const aa = a.length > EDIT_DIFF_CAP ? a.slice(0, EDIT_DIFF_CAP) : a;
  const bb = b.length > EDIT_DIFF_CAP ? b.slice(0, EDIT_DIFF_CAP) : b;
  const maxLen = Math.max(aa.length, bb.length);
  if (maxLen === 0) return 1;
  return 1 - Math.min(editDistance(aa, bb), maxLen) / maxLen;
}

/** 空白归一化：所有空白折叠为单个空格并去首尾（用于「差异仅在空白」的判定）。 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 一行前导空白（空格 / Tab）。 */
function leadingWhitespace(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/**
 * 差异类型诊断：old_string 与文件最相近片段之间「差在哪」。
 * 优先级：纯回车（CRLF/LF）→ 纯空白（缩进/换行）→ 纯大小写 → 一般字符差异。
 */
function describeDifference(oldString: string, candidate: string): string {
  // 1) 纯回车差异：文件用 CRLF 而 old_string 用 LF（或反之）
  if (oldString.replace(/\r/g, '') === candidate.replace(/\r/g, '')) {
    return oldString.includes('\r')
      ? '行尾回车符：old_string 含 CRLF 行尾，而文件里是 LF。请去掉 old_string 中的 \\r（改用文件实际行尾）后重试。'
      : '行尾回车符：文件使用 CRLF 行尾（Windows），而 old_string 用的是 LF。请把 old_string 的换行改为文件实际行尾（可先用 Read 确认）后重试。';
  }

  const normOld = normalizeWhitespace(oldString);
  const normCand = normalizeWhitespace(candidate);

  // 2) 空白归一后相等：差异只在缩进 / 换行 / 空格数量
  if (normOld === normCand) {
    const oldLines = oldString.split('\n');
    const candLines = candidate.split('\n');
    const hints: string[] = ['空白（缩进 / 换行 / 空格）与文件不一致'];
    if (oldLines.length !== candLines.length) {
      hints.push(
        `old_string 有 ${oldLines.length} 行，文件片段有 ${candLines.length} 行（换行数量不同）`,
      );
    }
    const oldIndent = leadingWhitespace(oldLines[0]);
    const candIndent = leadingWhitespace(candLines[0]);
    if (oldIndent !== candIndent) {
      hints.push(
        `首行缩进不同：old_string 用 ${JSON.stringify(oldIndent)}，文件用 ${JSON.stringify(candIndent)}`,
      );
    }
    return `差异在${hints.join('；')}。请对照文件实际空白（缩进 / 换行 / 空格）逐字符修正 old_string 后重试。`;
  }

  // 3) 忽略大小写后相等：大小写差异
  if (normOld.toLowerCase() === normCand.toLowerCase()) {
    return '大小写不同：old_string 与文件内容仅大小写不一致（如函数名 / 关键字）。请对照文件实际大小写修正 old_string 后重试。';
  }

  // 4) 一般字符差异：定位第一个不同点，给出两侧上下文
  let i = 0;
  while (
    i < normOld.length &&
    i < normCand.length &&
    normOld[i] === normCand[i]
  ) {
    i++;
  }
  const contextLen = 24;
  const fromOld = normOld.slice(Math.max(0, i - contextLen), i + contextLen);
  const fromCand = normCand.slice(Math.max(0, i - contextLen), i + contextLen);
  const showOld = JSON.stringify(
    fromOld.length > 48 ? `${fromOld.slice(0, 48)}…` : fromOld,
  );
  const showCand = JSON.stringify(
    fromCand.length > 48 ? `${fromCand.slice(0, 48)}…` : fromCand,
  );
  return `字符不同：第 ${i + 1} 个字符起，old_string 为 ${showOld}，文件为 ${showCand}。请对照文件实际内容修正 old_string 后重试。`;
}

/** 渲染行范围（带行号 + 上下文行）：窗口内用 `>` 标记，上下文行用空格。 */
function renderLinesWithNumbers(
  lines: string[],
  start: number,
  end: number, // exclusive
  context: number,
): string {
  const from = Math.max(0, start - context);
  const to = Math.min(lines.length, end + context);
  const width = Math.max(1, String(to).length);
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const inWindow = i >= start && i < end;
    const raw = lines[i];
    const clipped = raw.length > EDIT_DISPLAY_LINE_MAX;
    const text = clipped ? `${raw.slice(0, EDIT_DISPLAY_LINE_MAX)}…` : raw;
    out.push(
      `${inWindow ? '>' : ' '} ${String(i + 1).padStart(width)} | ${text}`,
    );
  }
  return out.join('\n');
}

/** 展示片段：过长裁剪，并用 JSON 转义让空白 / 换行可见。 */
function displaySnippet(text: string): string {
  const max = 200;
  const clipped = text.length > max ? `${text.slice(0, max)}…` : text;
  return JSON.stringify(clipped);
}

/** 截断到 EDIT_PAYLOAD_DIFF_MAX（超长保留头部；编辑差异通常集中在头部，展示粒度足够）。 */
function capDiffText(text: string): string {
  return text.length > EDIT_PAYLOAD_DIFF_MAX
    ? text.slice(0, EDIT_PAYLOAD_DIFF_MAX)
    : text;
}

/**
 * 相似片段搜索（old_string 0 次匹配时调用）：粗筛 + 精评两阶段。
 * 返回 null 表示「文件中没有相近片段」（空文件 / 共享字符太少 / 相似度低于阈值）。
 */
function findBestSimilar(
  content: string,
  oldString: string,
): Suggestion | null {
  const lines = content.split('\n');
  if (lines.length === 1 && lines[0] === '') return null; // 空文件

  const oldLineCount = oldString.split('\n').length;
  const ngramIndex = buildNgramIndex(oldString);

  // 粗筛：每行 n-gram 命中数，取前 N 行（无共享字符片段则直接判「无相近」）
  const scores = lines.map((line) => ngramHits(line, ngramIndex));
  let maxScore = 0;
  for (const s of scores) if (s > maxScore) maxScore = s;
  if (maxScore === 0) return null;
  const top = topIndices(scores, EDIT_SCAN_CANDIDATES);

  // 候选窗口：top 行及其前/后 1 行起、长度 = old_string 行数的窗口（去重）；
  // 再补文件头与文件尾窗口，覆盖「目标在边缘」与「短文件」情形。
  const candidates = new Map<string, { start: number; end: number }>();
  for (const t of top) {
    for (const delta of [-1, 0, 1]) {
      const start = t + delta;
      const end = start + oldLineCount;
      if (start >= 0 && end <= lines.length) {
        candidates.set(`${start}:${end}`, { start, end });
      }
    }
  }
  for (const start of [0, Math.max(0, lines.length - oldLineCount)]) {
    const end = start + oldLineCount;
    if (end <= lines.length) candidates.set(`${start}:${end}`, { start, end });
  }

  // 精评：编辑距离相似度，按「空白归一后的相似度」为主键、原样相似度为次键
  const normOld = normalizeWhitespace(oldString);
  let best:
    { start: number; end: number; normSim: number; rawSim: number } | undefined;
  for (const { start, end } of candidates.values()) {
    const windowText = lines.slice(start, end).join('\n');
    const normSim = similarity(normOld, normalizeWhitespace(windowText));
    const rawSim = similarity(oldString, windowText);
    if (
      best === undefined ||
      normSim > best.normSim ||
      (normSim === best.normSim && rawSim > best.rawSim) ||
      (normSim === best.normSim && rawSim === best.rawSim && start < best.start)
    ) {
      best = { start, end, normSim, rawSim };
    }
  }
  if (
    best === undefined ||
    Math.max(best.normSim, best.rawSim) < EDIT_SIMILARITY_FLOOR
  ) {
    return null;
  }

  const windowText = lines.slice(best.start, best.end).join('\n');
  return {
    line: best.start + 1,
    snippet: renderLinesWithNumbers(
      lines,
      best.start,
      best.end,
      EDIT_CONTEXT_LINES,
    ),
    difference: describeDifference(oldString, windowText),
  };
}

/** 0 次匹配的可诊断结果：最相近片段 + 差异提示，让模型一次修好。 */
function noMatchOutcome(
  path: string,
  content: string,
  oldString: string,
): ToolOutcome {
  if (content.length === 0) {
    return fail(
      `文件 "${path}" 为空（0 字节），没有可匹配的内容。Edit 只能修改已有文本；新建 / 填充内容请用 Write。`,
      { path, replaced: false, occurrenceCount: 0, error: 'no_match' },
    );
  }

  const suggestion = findBestSimilar(content, oldString);
  if (suggestion === null) {
    return fail(
      `未找到精确匹配：old_string 未在 "${path}" 中出现（出现 0 次），且文件中没有与 old_string 相近的片段（共享字符太少）。` +
        `请先用 Read / Grep 定位目标内容的实际文本，再据实修正 old_string（注意缩进、标点、大小写与换行）后重试。`,
      { path, replaced: false, occurrenceCount: 0, error: 'no_match' },
    );
  }

  return fail(
    `未找到精确匹配：old_string 未在 "${path}" 中出现（出现 0 次）。` +
      `\n最相近的片段在第 ${suggestion.line} 行附近：\n${suggestion.snippet}` +
      `\n差异提示：${suggestion.difference}` +
      `\n建议：先用 Read 读取第 ${suggestion.line} 行附近确认实际内容，再按差异提示修正 old_string（缩进、换行、标点、大小写需逐字符一致）后重试。`,
    {
      path,
      replaced: false,
      occurrenceCount: 0,
      error: 'no_match',
      suggestion,
    },
  );
}

/** 匹配不唯一的可诊断结果：列出各位置（行号 + 上下文），提示 replace_all 或补充上下文。 */
function ambiguousOutcome(
  path: string,
  content: string,
  matches: MatchPosition[],
  oldString: string,
): ToolOutcome {
  const lines = content.split('\n');
  const oldLineCount = oldString.split('\n').length;
  const shown = matches.slice(0, EDIT_AMBIGUOUS_LIST_MAX);
  const extra = matches.length - shown.length;

  const blocks = shown.map((m) => {
    const startLine = m.line - 1; // 0-based
    const endLine = Math.min(lines.length, startLine + oldLineCount);
    return renderLinesWithNumbers(
      lines,
      startLine,
      endLine,
      EDIT_CONTEXT_LINES,
    );
  });
  const list = blocks.join('\n\n');

  const text =
    `未找到唯一匹配：old_string 在 "${path}" 中出现 ${matches.length} 次` +
    `（匹配不唯一）${extra > 0 ? `，另有 ${extra} 处未列出` : ''}。` +
    `\n匹配位置：\n${list}` +
    `\n匹配不唯一，请二选一：\n` +
    `  1) 若确认要替换全部匹配，传 replace_all: true；\n` +
    `  2) 否则把 old_string 扩成包含前后行的更长片段（带足上下文），使其在文件中只出现一次。`;

  return fail(text, {
    path,
    replaced: false,
    occurrenceCount: matches.length,
    matches: shown.map((m) => ({
      line: m.line,
      context: m.lineText.slice(0, EDIT_DISPLAY_LINE_MAX),
    })),
    error: 'ambiguous_match',
  });
}

/** 执行一次 Edit（由 createEditTool 闭包注入运行时选项）。 */
async function executeEdit(
  args: EditArgs,
  ctx: ToolContext,
  runtime: EditRuntimeOptions,
): Promise<ToolOutcome> {
  const cwd = ctx.cwd ?? process.cwd();
  const absPath = isAbsolute(args.path) ? args.path : resolve(cwd, args.path);
  const oldString = args.old_string;
  const newString = args.new_string;
  const replaceAll = args.replace_all ?? false;

  // 运行期防御：schema 已挡空串，但直接 execute（测试 / 特化场景）也可能带进来
  if (oldString.length === 0) {
    return fail(
      'old_string 不能为空字符串：空串会命中任意位置（包括行首 / 行尾），无法执行安全的唯一替换。' +
        '请提供要替换的具体内容（如需删除片段，new_string 传空字符串即可）。',
      {
        path: absPath,
        replaced: false,
        occurrenceCount: 0,
        error: 'old_string_empty',
      },
    );
  }

  if (ctx.signal.aborted) {
    return fail(`编辑 "${absPath}" 已中断（收到中止信号），未执行。`, {
      path: absPath,
      replaced: false,
      occurrenceCount: 0,
      error: 'interrupted',
    });
  }

  // ① stat：大文件保护 + 目录 / 非常规文件识别
  let st;
  try {
    st = await stat(absPath);
  } catch (caught) {
    return fileErrorOutcome(absPath, caught);
  }
  if (st.size > runtime.maxBytes) {
    return fail(
      `文件 "${absPath}" 过大（${formatBytes(st.size)}，超过上限 ${formatBytes(runtime.maxBytes)}）。` +
        `Edit 需整读文件做精确匹配与替换，已拒绝。建议用 Grep 定位目标内容，或改用 Write 整体重写该文件。`,
      {
        path: absPath,
        replaced: false,
        occurrenceCount: 0,
        error: 'too_large',
      },
    );
  }
  if (st.isDirectory()) {
    return fail(
      `"${absPath}" 是一个目录，Edit 工具只能修改文件。请换用文件路径后重试。`,
      {
        path: absPath,
        replaced: false,
        occurrenceCount: 0,
        error: 'is_directory',
      },
    );
  }
  if (!st.isFile()) {
    return fail(
      `"${absPath}" 已存在但不是普通文件（可能是 FIFO / 套接字 / 设备），Edit 已拒绝。请换用文件路径后重试。`,
      {
        path: absPath,
        replaced: false,
        occurrenceCount: 0,
        error: 'not_regular_file',
      },
    );
  }

  // ② 解析真实路径 + 防盲写。
  // 真实路径有两个用途：a) 目标若是符号链接，写回必须落在链接指向的真实
  // 文件上——否则原子写（rename）会把符号链接本身替换成普通文件，这是
  // 危险的破坏性误操作；b) 已读检查用 absPath 或 realpath 任一命中即可。
  const realPath = await realpath(absPath).catch(() => absPath);
  let readable = ctx.readFiles !== undefined && ctx.readFiles.has(absPath);
  if (!readable) {
    readable = ctx.readFiles !== undefined && ctx.readFiles.has(realPath);
  }
  if (!readable) {
    return fail(
      `目标文件 "${absPath}" 已存在，且本会话尚未读取过该文件。为防止盲改，` +
        `请先用 Read 工具读取该文件，再重试 Edit。`,
      {
        path: absPath,
        replaced: false,
        occurrenceCount: 0,
        error: 'not_read_before_edit',
      },
    );
  }

  // ③ 整读内容（大文件保护已在上方拒绝；经符号链接读取即真实文件内容）
  let content: string;
  try {
    content = await readFile(absPath, 'utf8');
  } catch (caught) {
    if (ctx.signal.aborted) throw caught; // 中断交给管线归一为「执行被中断」
    return fileErrorOutcome(absPath, caught);
  }

  // 二进制保护：NUL 字节是最强信号，避免对二进制做无意义匹配与写回
  if (content.includes('\0')) {
    return fail(
      `文件 "${absPath}" 疑似二进制（检测到 NUL 字节），Edit 只支持文本编辑。` +
        `请用 Grep 定位目标内容，或换用其他工具处理。`,
      { path: absPath, replaced: false, occurrenceCount: 0, error: 'binary' },
    );
  }

  // ④ 统计全部出现次数（非重叠）
  const matches = findAllMatches(content, oldString);
  const occurrenceCount = matches.length;

  if (occurrenceCount === 0) {
    return noMatchOutcome(absPath, content, oldString);
  }
  if (occurrenceCount > 1 && !replaceAll) {
    return ambiguousOutcome(absPath, content, matches, oldString);
  }

  // ⑤ 替换：唯一匹配直接替换；replace_all 用 split/join 全部替换
  let newContent: string;
  if (occurrenceCount === 1) {
    const first = matches[0];
    newContent =
      content.slice(0, first.index) +
      newString +
      content.slice(first.index + oldString.length);
  } else {
    newContent = content.split(oldString).join(newString);
  }

  // ⑥ 原子写回（保留原 mode；符号链接时写到真实文件，见 ②）
  const mode = st.mode & 0o777;
  try {
    await writeFileAtomically(realPath, newContent, ctx.signal, mode);
  } catch (caught) {
    if (ctx.signal.aborted) {
      return fail(
        `编辑 "${absPath}" 已中断（收到中止信号），目标文件未被改动。`,
        {
          path: absPath,
          replaced: false,
          occurrenceCount,
          error: 'interrupted',
        },
      );
    }
    return writeErrorOutcome(absPath, caught, occurrenceCount);
  }

  const newBytes = Buffer.byteLength(newContent, 'utf8');
  const first = matches[0];
  const pathLabel =
    realPath === absPath
      ? absPath
      : `${absPath}（符号链接，实际编辑 ${realPath}）`;
  // 写入上报（T-123 写冲突检测）：成功落盘后自报实际写入路径（符号链接时
  // 报真实文件），运行时据此维护写冲突检测。
  ctx.onFileWrite?.(realPath);
  const forModel =
    `已替换 "${pathLabel}"：old_string 出现 ${occurrenceCount} 次` +
    (replaceAll ? '（已全部替换）' : '') +
    `，匹配在第 ${first.line} 行。\n` +
    `替换前：${displaySnippet(oldString)}\n` +
    `替换后：${displaySnippet(newString)}\n` +
    `文件现有 ${newContent.split('\n').length} 行 · ${formatBytes(newBytes)}。`;
  return {
    ok: true,
    forModel,
    summary:
      `Edit ${absPath}：替换 ${occurrenceCount} 处` +
      (occurrenceCount > 1 ? '（全部）' : ''),
    payload: {
      path: absPath,
      replaced: true,
      occurrenceCount,
      newBytes,
      old_string: capDiffText(oldString),
      new_string: capDiffText(newString),
    },
  };
}

/** 构造 Edit 工具（可用选项覆盖默认阈值；测试用）。 */
export function createEditTool(
  options: EditToolOptions = {},
): Tool<typeof editSchema> {
  const runtime: EditRuntimeOptions = {
    maxBytes: options.maxBytes ?? EDIT_MAX_BYTES,
  };
  return {
    name: 'edit',
    description:
      '修改文件内容：把文件中唯一出现的 old_string 替换为 new_string。' +
      'path 必填（相对当前工作目录或绝对路径）；old_string 必填（要匹配的原文，' +
      '必须与文件内容逐字符一致，含正确的缩进与换行）；new_string 必填（替换后的文本，' +
      '传空字符串表示删除该片段）；replace_all 可选（boolean，默认 false，true 时替换全部匹配）。\n' +
      '编辑纪律：\n' +
      '- 编辑前必须先 Read 该文件（防盲写：未读会拒绝）；\n' +
      '- old_string 必须唯一匹配：匹配不唯一时工具会列出各匹配位置（行号 + 上下文），' +
      '请补充更多上下文行（如前一行的代码）使 old_string 唯一，或改用 replace_all: true；\n' +
      '- 找不到精确匹配时，工具会返回最相近片段与差异提示（缩进 / 换行 / 标点 / 大小写），' +
      '请据此修正 old_string 后重试。\n' +
      '写入为原子操作，保留原文件权限位。',
    schema: editSchema,
    risk: 'write',
    execute: (args: EditArgs, ctx: ToolContext) =>
      executeEdit(args, ctx, runtime),
  };
}

/** 默认 Edit 工具实例（T-031，risk: write，0.3.0 写工具集之一）。 */
export const editTool: Tool<typeof editSchema> = createEditTool();
