import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  findRgBinary,
  runRgLines,
  type RgBinary,
  type RgResolverOptions,
} from '../rg';
import type { Tool, ToolContext, ToolOutcome } from '../types';

/**
 * Grep 工具（T-022）：用正则表达式在文件或目录中搜索文本（封装 ripgrep `--json`）。
 *
 * 设计依据（docs/design/002-architecture.md 5.2 / 5.3 / 5.4）：
 * - 错误即数据：无匹配、路径不存在、rg 不可用、rg 执行失败，全部返回
 *   `ok:false` 的可诊断文本回喂模型自纠（含下一步建议），不抛异常；
 * - 输出治理：forModel 纯文本（按文件聚组、带行号）+ payload 结构化
 *   （matches 按文件分组，含每文件命中数与片段），超出 maxResults 明确提示
 *   「已截断，仅显示前 N 条命中」——截断要出声，模型才知道信息不全；
 * - 片段行过长时裁剪（GREP_SNIPPET_MAX），避免单行把输出撑爆；
 * - rg 默认行为即工具默认行为：尊重 .gitignore、排除隐藏文件与二进制文件。
 *
 * 实现要点：`rg --json --line-number [-i] [--glob g] -- pattern path`，逐行解析
 * JSONL 的 `match` 事件，收集达到 maxResults 即终止子进程（runRgLines 的截断
 * 语义），不做无限缓冲。
 */

/** 未传 maxResults 时的默认命中上限。 */
export const DEFAULT_GREP_MAX_RESULTS = 200;
/** maxResults 上限：单次搜索最多收集的命中数，超出请缩小范围（加 glob / 换 pattern）。 */
export const GREP_MAX_RESULTS_MAX = 2_000;
/** 单行片段裁剪上限（字符）：超长行只保留前 N 字符，防止 minified 代码撑爆输出。 */
export const GREP_SNIPPET_MAX = 500;

/** Grep 工具参数 schema（zod）。pattern 必填；path/glob 可选；ignoreCase 可选。 */
export const grepSchema = z.object({
  pattern: z.string().min(1, 'pattern 不能为空字符串'),
  path: z.string().min(1, 'path 不能为空字符串').optional(),
  glob: z.string().min(1, 'glob 不能为空字符串').optional(),
  ignoreCase: z.boolean().optional(),
  maxResults: z
    .number()
    .int('maxResults 必须是整数')
    .positive('maxResults 必须是正整数')
    .max(
      GREP_MAX_RESULTS_MAX,
      `maxResults 最大支持 ${GREP_MAX_RESULTS_MAX} 条命中，超出请用 glob 过滤缩小范围`,
    )
    .optional(),
});

export type GrepArgs = z.infer<typeof grepSchema>;

/** 一条命中（文件内一行）：行号 + 片段 + 子匹配区间（给前端高亮）。 */
export interface GrepMatchLine {
  readonly lineNumber: number;
  readonly text: string;
  /** 片段是否被裁剪（行过长，只保留了前 GREP_SNIPPET_MAX 字符）。 */
  readonly clipped: boolean;
  /**
   * 子匹配区间（给前端高亮）。**注意：start/end 是 ripgrep 的字节偏移**，
   * 而 `text` 是 JS 字符串；含多字节字符时 `text.slice(start, end)` 会错位，
   * 前端需按 `Buffer.byteLength` 映射到字符偏移后再切片。
   */
  readonly submatches: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }>;
}

/** 按文件聚组的一处命中集合。 */
export interface GrepFileGroup {
  readonly path: string;
  readonly matchCount: number;
  readonly lines: ReadonlyArray<GrepMatchLine>;
}

/** Grep 结构化载荷（成功与错误共用：错误时 error/detail 存在，matches 字段缺失）。 */
export interface GrepPayload {
  readonly pattern: string;
  readonly path: string;
  readonly glob?: string;
  readonly ignoreCase: boolean;
  readonly totalMatches?: number;
  readonly fileCount?: number;
  readonly files?: ReadonlyArray<GrepFileGroup>;
  readonly truncated?: boolean;
  /** 错误码：rg 不可用 / 路径不存在 / 无匹配 / rg 执行失败。 */
  readonly error?:
    | 'rg_unavailable'
    | 'not_found'
    | 'not_searchable'
    | 'permission_denied'
    | 'no_match'
    | 'rg_error';
  readonly detail?: string;
}

/** 工具选项：允许测试与特化场景覆盖默认值 / 注入 rg 解析。 */
export interface GrepToolOptions {
  /** 未传 maxResults 时的命中上限。默认 200。 */
  readonly defaultMaxResults?: number;
  /** 单行片段裁剪上限（字符）。默认 500。 */
  readonly snippetMax?: number;
  /** rg 解析注入项（测试用），见 RgResolverOptions。 */
  readonly rgOptions?: RgResolverOptions;
  /** 完全替换 rg 解析函数（测试用）。 */
  readonly findRg?: (options?: RgResolverOptions) => Promise<RgBinary | null>;
}

/** 解析后的运行时选项（默认值已展开）。 */
interface GrepRuntimeOptions {
  readonly defaultMaxResults: number;
  readonly snippetMax: number;
  readonly rgOptions?: RgResolverOptions;
  readonly findRg?: (options?: RgResolverOptions) => Promise<RgBinary | null>;
}

/** 失败结果（错误即数据）：payload 携带结构化错误码供前端渲染。 */
function fail(forModel: string, payload?: unknown): ToolOutcome {
  return payload === undefined
    ? { ok: false, forModel }
    : { ok: false, forModel, payload };
}

/** 路径探测结果：存在性 / 类型 / 权限。 */
type PathProbe =
  | {
      readonly kind: 'ok';
      readonly isFile: boolean;
      readonly isDirectory: boolean;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'permission_denied' }
  | { readonly kind: 'other'; readonly message: string };

/** 探测一个路径（存在性 + 文件/目录类型），fs 错误映射为可诊断结果。 */
async function probePath(absPath: string): Promise<PathProbe> {
  try {
    const st = await stat(absPath);
    return {
      kind: 'ok',
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
    };
  } catch (caught) {
    const code =
      typeof caught === 'object' && caught !== null && 'code' in caught
        ? (caught as { readonly code?: unknown }).code
        : undefined;
    if (code === 'ENOENT') return { kind: 'not_found' };
    if (code === 'EACCES' || code === 'EPERM')
      return { kind: 'permission_denied' };
    return {
      kind: 'other',
      message: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

/** rg JSONL 事件（仅取 Grep 需要的字段，其余丢弃）。 */
interface RgJsonEvent {
  readonly type: string;
  readonly path?: string;
  readonly lineNumber?: number;
  readonly linesText?: string;
  readonly submatches?: ReadonlyArray<{
    readonly start?: number;
    readonly end?: number;
    readonly text?: string;
  }>;
}

/** 解析一行 rg --json 输出。解析失败（理论不该发生）返回 null，调用方跳过。 */
function parseRgEvent(line: string): RgJsonEvent | null {
  try {
    const obj = JSON.parse(line) as {
      readonly type?: unknown;
      readonly data?: {
        readonly path?: { readonly text?: unknown };
        readonly lines?: { readonly text?: unknown };
        readonly line_number?: unknown;
        readonly submatches?: ReadonlyArray<{
          readonly match?: { readonly text?: unknown };
          readonly start?: unknown;
          readonly end?: unknown;
        }>;
      };
    };
    if (typeof obj.type !== 'string') return null;
    const data = obj.data;
    if (data === undefined) return { type: obj.type };
    return {
      type: obj.type,
      path: typeof data.path?.text === 'string' ? data.path.text : undefined,
      lineNumber:
        typeof data.line_number === 'number' ? data.line_number : undefined,
      linesText:
        typeof data.lines?.text === 'string' ? data.lines.text : undefined,
      submatches: Array.isArray(data.submatches)
        ? data.submatches.map((sm) => ({
            start: typeof sm?.start === 'number' ? sm.start : undefined,
            end: typeof sm?.end === 'number' ? sm.end : undefined,
            text:
              typeof sm?.match?.text === 'string' ? sm.match.text : undefined,
          }))
        : undefined,
    };
  } catch {
    return null;
  }
}

/** 裁剪超长片段：保留前 snippetMax 字符，超出标记 clipped。 */
function clipSnippet(
  text: string,
  snippetMax: number,
): {
  readonly text: string;
  readonly clipped: boolean;
} {
  if (text.length <= snippetMax) return { text, clipped: false };
  return { text: text.slice(0, snippetMax), clipped: true };
}

/** 结果路径展示：位于搜索基准目录下时显示相对路径，否则保持绝对路径。 */
function displayPath(abs: string, base: string): string {
  const rel = relative(base, abs);
  if (rel.length > 0 && !rel.startsWith('..')) return rel;
  return abs;
}

/** 渲染成功结果：forModel 纯文本（按文件聚组 + 行号对齐）+ 给人看的 summary。 */
function renderMatches(
  payload: Omit<
    GrepPayload,
    'totalMatches' | 'fileCount' | 'files' | 'truncated'
  > & {
    readonly totalMatches: number;
    readonly fileCount: number;
    readonly files: ReadonlyArray<GrepFileGroup>;
    readonly truncated: boolean;
    readonly maxResults: number;
  },
): string {
  const { pattern, path, glob, ignoreCase } = payload;
  const header =
    `在 "${path}" 下搜索 ${JSON.stringify(pattern)}` +
    `（${ignoreCase ? '忽略大小写' : '区分大小写'}）` +
    (glob !== undefined ? `，glob 过滤 ${JSON.stringify(glob)}` : '');
  const lines: string[] = [
    header,
    payload.truncated
      ? `已显示前 ${payload.totalMatches} 条命中（超过上限已截断，还有更多命中未列出）。`
      : `共 ${payload.totalMatches} 处命中，分布在 ${payload.fileCount} 个文件。`,
    '',
  ];
  for (const file of payload.files) {
    const last = file.lines[file.lines.length - 1];
    const width = Math.max(1, String(last?.lineNumber ?? 0).length);
    lines.push(
      `── ${displayPath(file.path, path)}（${file.matchCount} 处命中）──`,
    );
    for (const match of file.lines) {
      const snippet = match.clipped ? `${match.text} …` : match.text;
      lines.push(`${String(match.lineNumber).padStart(width)} | ${snippet}`);
    }
  }
  if (payload.truncated) {
    lines.push('');
    lines.push(
      `[已截断：仅显示前 ${payload.maxResults} 条命中，还有更多命中未列出。` +
        '建议用 glob 过滤缩小范围，或换一个更具体的 pattern。]',
    );
  }
  return lines.join('\n');
}

/** 无匹配的可诊断结果：给出可尝试的下一步方向（错误即数据）。 */
function noMatchOutcome(basePayload: Omit<GrepPayload, 'error'>): ToolOutcome {
  const { pattern, path, glob, ignoreCase } = basePayload;
  const lines = [
    `未找到匹配 ${JSON.stringify(pattern)} 的内容（在 "${path}"` +
      (glob !== undefined ? `，glob 过滤 ${JSON.stringify(glob)}` : '') +
      '）。',
    '可尝试以下方向：',
    ...(ignoreCase
      ? []
      : ['- 加上 ignoreCase=true 忽略大小写（当前区分大小写）；']),
    '- 换一个更宽泛的 pattern（如只保留关键词的一部分，或拆成更短的词）；',
    '- 确认目标文件确实在该路径下：可先用 Glob 工具按文件名定位，再用 Read 确认内容；',
    ...(glob !== undefined
      ? [
          '- 确认 glob 过滤没有把目标文件排除（rg 默认忽略 .gitignore 与隐藏文件）。',
        ]
      : ['- 注意 rg 默认忽略 .gitignore 与隐藏文件。']),
  ];
  return fail(lines.join('\n'), { ...basePayload, error: 'no_match' });
}

/** rg 退出码 2（fatal 错误）→ 按 stderr 内容映射为可诊断文本。 */
function rgFatalOutcome(
  basePayload: Omit<GrepPayload, 'error'>,
  stderr: string,
): ToolOutcome {
  const detail = stderr.trim();
  if (detail.includes('No such file or directory')) {
    return fail(
      `搜索路径 "${basePayload.path}" 无法访问：${detail}\n` +
        '请确认路径存在且可读（可先用 Glob 确认路径，或用 Read 读取确认）。',
      { ...basePayload, error: 'not_found', detail },
    );
  }
  if (detail.includes('regex parse error')) {
    return fail(
      `pattern 无效：rg 无法解析该正则表达式。\n${detail}\n` +
        '可尝试：检查正则语法（如未闭合的 [ 或 (），或改用字面量匹配（特殊字符需转义）。',
      { ...basePayload, error: 'rg_error', detail },
    );
  }
  return fail(`rg 执行失败：${detail}`, {
    ...basePayload,
    error: 'rg_error',
    detail,
  });
}

/** 执行一次 Grep（由 createGrepTool 闭包注入运行时选项）。 */
async function executeGrep(
  args: GrepArgs,
  ctx: ToolContext,
  runtime: GrepRuntimeOptions,
): Promise<ToolOutcome> {
  const cwd = ctx.cwd ?? process.cwd();
  const searchPath =
    args.path !== undefined
      ? isAbsolute(args.path)
        ? args.path
        : resolve(cwd, args.path)
      : (ctx.cwd ?? ctx.projectRoot ?? process.cwd());
  const ignoreCase = args.ignoreCase ?? false;
  const maxResults = args.maxResults ?? runtime.defaultMaxResults;

  const basePayload: Omit<GrepPayload, 'error'> = {
    pattern: args.pattern,
    path: searchPath,
    ...(args.glob !== undefined ? { glob: args.glob } : {}),
    ignoreCase,
  };

  // ① rg 可用性：不可用 → 可诊断（错误即数据）
  const binary = await (runtime.findRg ?? findRgBinary)(runtime.rgOptions);
  if (binary === null) {
    return fail(
      'Grep 无法执行：未找到可用的 ripgrep 二进制（捆绑 @vscode/ripgrep 与系统 rg 都不可用）。' +
        '请安装系统 ripgrep（如 `apt install ripgrep` / `brew install ripgrep`）后重试。',
      { ...basePayload, error: 'rg_unavailable' },
    );
  }

  // ② 路径探测：不存在 / 无权限 / 非文件非目录 → 可诊断
  const probe = await probePath(searchPath);
  if (probe.kind === 'not_found') {
    return fail(
      `搜索路径 "${searchPath}" 不存在（ENOENT）。请核对路径：相对路径相对当前工作目录解析，` +
        '也可使用绝对路径；可先用 Glob 确认目标位置再重试。',
      { ...basePayload, error: 'not_found' },
    );
  }
  if (probe.kind === 'permission_denied') {
    return fail(
      `搜索路径 "${searchPath}" 无读取权限（EACCES/EPERM）。请确认该路径可读（含所在目录的遍历权限）后重试。`,
      { ...basePayload, error: 'permission_denied' },
    );
  }
  if (probe.kind === 'other') {
    return fail(`搜索路径 "${searchPath}" 无法访问：${probe.message}`, {
      ...basePayload,
      error: 'not_searchable',
    });
  }
  if (!probe.isDirectory && !probe.isFile) {
    return fail(
      `"${searchPath}" 不是普通文件或目录（可能是设备 / 管道 / 套接字），无法搜索。`,
      { ...basePayload, error: 'not_searchable' },
    );
  }

  // ③ 运行 rg：--json 逐行解析 match 事件，收集满 maxResults 即终止
  const rgArgs = [
    '--json',
    '--line-number',
    '--no-messages',
    ...(ignoreCase ? ['-i'] : []),
    ...(args.glob !== undefined ? ['--glob', args.glob] : []),
    '--',
    args.pattern,
    searchPath,
  ];

  const groups = new Map<
    string,
    { matchCount: number; lines: GrepMatchLine[] }
  >();
  let totalMatches = 0;
  let truncated = false;

  let runResult: Awaited<ReturnType<typeof runRgLines>>;
  try {
    runResult = await runRgLines(binary, rgArgs, {
      signal: ctx.signal,
      onLine: (line) => {
        const event = parseRgEvent(line);
        if (
          event === null ||
          event.type !== 'match' ||
          event.path === undefined
        ) {
          return true;
        }
        // 命中数已达上限：立即停止（不处理该行）——只有真实存在第 N+1 条
        // 命中时才触发截断，避免「恰好等于 maxResults」时谎报已截断
        if (totalMatches >= maxResults) {
          return false;
        }
        const raw = (event.linesText ?? '').replace(/\r?\n$/, '');
        const { text, clipped } = clipSnippet(raw, runtime.snippetMax);
        let group = groups.get(event.path);
        if (group === undefined) {
          group = { matchCount: 0, lines: [] };
          groups.set(event.path, group);
        }
        group.matchCount += 1;
        group.lines.push({
          lineNumber: event.lineNumber ?? 0,
          text,
          clipped,
          submatches: clipped
            ? []
            : (event.submatches ?? [])
                .filter(
                  (
                    sm,
                  ): sm is {
                    readonly start: number;
                    readonly end: number;
                    readonly text?: string;
                  } =>
                    typeof sm.start === 'number' && typeof sm.end === 'number',
                )
                .map((sm) => ({
                  start: sm.start,
                  end: sm.end,
                  text: sm.text ?? '',
                })),
        });
        totalMatches += 1;
        return true; // 继续读；截断判定在回调顶部（发现下一条超限命中才停）
      },
    });
  } catch (caught) {
    if (ctx.signal.aborted) throw caught; // 中断交给管线归一为「执行被中断」
    return fail(
      `rg 执行出错：${caught instanceof Error ? caught.message : String(caught)}`,
      { ...basePayload, error: 'rg_error' },
    );
  }

  if (ctx.signal.aborted) throw new Error('Grep 执行被中断');
  if (runResult.stopped) truncated = true;

  // ④ 未截断时按退出码分类：2 = rg 错误，1 = 无匹配
  if (!truncated) {
    if (runResult.exitCode === 2)
      return rgFatalOutcome(basePayload, runResult.stderr);
    if (runResult.exitCode === 1) return noMatchOutcome(basePayload);
    if (runResult.exitCode !== 0) {
      return fail(`rg 异常终止（退出码 ${String(runResult.exitCode)}）。`, {
        ...basePayload,
        error: 'rg_error',
      });
    }
  }

  if (totalMatches === 0) return noMatchOutcome(basePayload);

  // ⑤ 组装：按文件聚组（按路径排序，组内按行号排序）+ 双表示
  const files: GrepFileGroup[] = [...groups.entries()]
    .map(([path, group]) => ({
      path,
      matchCount: group.matchCount,
      lines: group.lines.slice().sort((a, b) => a.lineNumber - b.lineNumber),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const payload: GrepPayload = {
    ...basePayload,
    totalMatches,
    fileCount: files.length,
    files,
    truncated,
  };
  const forModel = renderMatches({
    pattern: args.pattern,
    path: searchPath,
    ...(args.glob !== undefined ? { glob: args.glob } : {}),
    ignoreCase,
    totalMatches,
    fileCount: files.length,
    files,
    truncated,
    maxResults,
  });
  return {
    ok: true,
    forModel,
    summary:
      `Grep ${JSON.stringify(args.pattern)}：${totalMatches} 处命中 / ${files.length} 个文件` +
      (truncated ? '（已截断）' : ''),
    payload,
    ...(truncated ? { truncated: { truncated: true } } : {}),
  };
}

/** 构造 Grep 工具（可用选项覆盖默认值 / 注入 rg 解析；测试用）。 */
export function createGrepTool(
  options: GrepToolOptions = {},
): Tool<typeof grepSchema> {
  const runtime: GrepRuntimeOptions = {
    defaultMaxResults: options.defaultMaxResults ?? DEFAULT_GREP_MAX_RESULTS,
    snippetMax: options.snippetMax ?? GREP_SNIPPET_MAX,
    ...(options.rgOptions !== undefined
      ? { rgOptions: options.rgOptions }
      : {}),
    ...(options.findRg !== undefined ? { findRg: options.findRg } : {}),
  };
  return {
    name: 'grep',
    description:
      '用正则表达式在文件或目录中搜索文本，返回命中行号与文本片段（封装 ripgrep）。' +
      'pattern 必填（正则表达式）；path 可选（默认当前工作目录，相对路径相对 cwd 解析）；' +
      'glob 可选（如 "**/*.ts"，过滤要搜索的文件，rg 默认尊重 .gitignore 并排除隐藏文件）；' +
      'ignoreCase 可选（true 时忽略大小写）；maxResults 可选（单次最多返回的命中数，默认 200）。' +
      '命中按文件聚组展示；超过上限会明确提示已截断并给出缩小范围的建议；' +
      '无匹配时返回可诊断提示（如建议加 ignoreCase 或换更宽泛的 pattern）。',
    schema: grepSchema,
    risk: 'read',
    execute: (args: GrepArgs, ctx: ToolContext) =>
      executeGrep(args, ctx, runtime),
  };
}

/** 默认 Grep 工具实例（0.2.0 只读工具集之一）。 */
export const grepTool: Tool<typeof grepSchema> = createGrepTool();
