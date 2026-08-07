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
 * Glob 工具（T-022）：按 glob 模式枚举目录下的文件，结果按修改时间排序（最新在前）。
 *
 * 设计依据（docs/design/002-architecture.md 5.2 / 5.3 / 5.4）：
 * - 实现走 rg `--files -g pattern`（复用 ripgrep 的目录遍历与 ignore 语义：
 *   默认尊重 .gitignore、排除隐藏文件，与 Grep 工具行为一致）；
 * - 排序：对每个匹配文件 stat 取 mtime，按修改时间降序（最新在前），
 *   平局按路径升序（确定性）——不依赖 rg 版本对 `--sort` 的支持；
 * - 错误即数据：无匹配 / 路径不存在 / 路径不是目录 / rg 不可用，全部返回
 *   `ok:false` 的可诊断文本回喂模型自纠（含建议），不抛异常；
 * - 输出治理：forModel 纯文本（文件列表）+ payload 结构化（files 数组），
 *   结果超过 maxResults 明确提示「已截断，仅显示前 N 个文件」。
 *
 * 实现要点：收集全部命中（带收集上限防病态大仓库），stat+排序，再按
 * maxResults 截断；收集上限命中时如实声明「仅统计了前 N 个」。
 */

/** 未传 maxResults 时的默认文件数上限。 */
export const DEFAULT_GLOB_MAX_RESULTS = 200;
/** maxResults 上限：单次最多返回的文件数，超出请用更具体的 glob 缩小范围。 */
export const GLOB_MAX_RESULTS_MAX = 2_000;
/** 收集上限：枚举到的文件数超过它即停止收集（防病态大仓库撑爆内存），如实声明。 */
export const GLOB_COLLECT_CAP = 100_000;

/** Glob 工具参数 schema（zod）。pattern 必填（glob）；path 可选（默认 cwd）。 */
export const globSchema = z.object({
  pattern: z.string().min(1, 'pattern 不能为空字符串'),
  path: z.string().min(1, 'path 不能为空字符串').optional(),
  maxResults: z
    .number()
    .int('maxResults 必须是整数')
    .positive('maxResults 必须是正整数')
    .max(
      GLOB_MAX_RESULTS_MAX,
      `maxResults 最大支持 ${GLOB_MAX_RESULTS_MAX} 个文件，超出请用更具体的 glob 缩小范围`,
    )
    .optional(),
});

export type GlobArgs = z.infer<typeof globSchema>;

/** Glob 结构化载荷（成功与错误共用：错误时 error/detail 存在，files 缺失）。 */
export interface GlobPayload {
  readonly pattern: string;
  readonly path: string;
  readonly totalFiles?: number;
  /** 文件绝对路径，按修改时间降序（最新在前）。 */
  readonly files?: ReadonlyArray<string>;
  readonly truncated?: boolean;
  /** 因 maxResults 省略的文件数。 */
  readonly omittedFiles?: number;
  /** 收集上限是否命中（枚举文件过多，totalFiles 是「已统计数」而非全量）。 */
  readonly collectCapped?: boolean;
  /** 收集命中时实际统计的文件数（= 收集上限）。 */
  readonly collectCapFiles?: number;
  /** 错误码：rg 不可用 / 路径不存在 / 路径不是目录 / 无匹配 / rg 执行失败。 */
  readonly error?:
    | 'rg_unavailable'
    | 'not_found'
    | 'not_a_directory'
    | 'permission_denied'
    | 'no_match'
    | 'rg_error';
  readonly detail?: string;
}

/** 工具选项：允许测试与特化场景覆盖默认值 / 注入 rg 解析。 */
export interface GlobToolOptions {
  /** 未传 maxResults 时的文件数上限。默认 200。 */
  readonly defaultMaxResults?: number;
  /** 收集上限。默认 100_000。 */
  readonly collectCap?: number;
  /** rg 解析注入项（测试用），见 RgResolverOptions。 */
  readonly rgOptions?: RgResolverOptions;
  /** 完全替换 rg 解析函数（测试用）。 */
  readonly findRg?: (options?: RgResolverOptions) => Promise<RgBinary | null>;
}

/** 解析后的运行时选项（默认值已展开）。 */
interface GlobRuntimeOptions {
  readonly defaultMaxResults: number;
  readonly collectCap: number;
  readonly rgOptions?: RgResolverOptions;
  readonly findRg?: (options?: RgResolverOptions) => Promise<RgBinary | null>;
}

/** 失败结果（错误即数据）：payload 携带结构化错误码供前端渲染。 */
function fail(forModel: string, payload?: unknown): ToolOutcome {
  return payload === undefined
    ? { ok: false, forModel }
    : { ok: false, forModel, payload };
}

/** 路径探测结果：存在性 / 目录类型 / 权限。 */
type PathProbe =
  | { readonly kind: 'ok'; readonly isDirectory: boolean }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'permission_denied' }
  | { readonly kind: 'other'; readonly message: string };

/** 探测一个路径（存在性 + 是否目录），fs 错误映射为可诊断结果。 */
async function probePath(absPath: string): Promise<PathProbe> {
  try {
    const st = await stat(absPath);
    return { kind: 'ok', isDirectory: st.isDirectory() };
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

/** 结果路径展示：位于搜索基准目录下时显示相对路径，否则保持绝对路径。 */
function displayPath(abs: string, base: string): string {
  const rel = relative(base, abs);
  if (rel.length > 0 && !rel.startsWith('..')) return rel;
  return abs;
}

/** 渲染成功结果：forModel 纯文本（文件列表）+ 给人看的 summary。 */
function renderFiles(
  payload: Omit<GlobPayload, 'error'>,
  maxResults: number,
): string {
  const { pattern, path } = payload;
  const files = payload.files ?? [];
  const lines = [
    `在 "${path}" 下匹配 glob ${JSON.stringify(pattern)}：共 ${payload.totalFiles ?? 0} 个文件` +
      `（按修改时间降序，最新在前）${payload.collectCapped === true ? '，但枚举文件过多仅统计了前 ' + String(payload.collectCapFiles ?? 0) + ' 个' : ''}。`,
    '',
    ...files.map((file) => displayPath(file, path)),
  ];
  if (payload.truncated === true) {
    lines.push(
      '',
      `[已截断：仅显示前 ${maxResults} 个文件，省略 ${String(payload.omittedFiles ?? 0)} 个。` +
        '建议用更具体的 glob 缩小范围。]',
    );
  }
  return lines.join('\n');
}

/** 无匹配的可诊断结果：给出可尝试的下一步方向（错误即数据）。 */
function noMatchOutcome(
  basePayload: Omit<GlobPayload, 'error'>,
  isDirectory: boolean,
): ToolOutcome {
  const { pattern, path } = basePayload;
  const lines = [
    `在 "${path}" 下未找到匹配 glob ${JSON.stringify(pattern)} 的文件。`,
    '可尝试以下方向：',
    '- 检查 glob 语法：跨目录用双星号，如 "**/*.ts"；单层目录用单星号，如 "src/*.ts"；',
    '- 确认路径存在' + (isDirectory ? '且目标文件确实在该路径下' : '') + '；',
    '- 注意大小写：文件系统区分大小写，模式里的字母大小写需与文件名一致；',
    '- 注意 rg 默认忽略 .gitignore 与隐藏文件（如需匹配请先调整 .gitignore 或用完整路径）。',
  ];
  return fail(lines.join('\n'), { ...basePayload, error: 'no_match' });
}

/** 执行一次 Glob（由 createGlobTool 闭包注入运行时选项）。 */
async function executeGlob(
  args: GlobArgs,
  ctx: ToolContext,
  runtime: GlobRuntimeOptions,
): Promise<ToolOutcome> {
  const cwd = ctx.cwd ?? process.cwd();
  const searchPath =
    args.path !== undefined
      ? isAbsolute(args.path)
        ? args.path
        : resolve(cwd, args.path)
      : (ctx.cwd ?? ctx.projectRoot ?? process.cwd());
  const maxResults = args.maxResults ?? runtime.defaultMaxResults;

  const basePayload: Omit<GlobPayload, 'error'> = {
    pattern: args.pattern,
    path: searchPath,
  };

  // ① rg 可用性：不可用 → 可诊断（错误即数据）
  const binary = await (runtime.findRg ?? findRgBinary)(runtime.rgOptions);
  if (binary === null) {
    return fail(
      'Glob 无法执行：未找到可用的 ripgrep 二进制（捆绑 @vscode/ripgrep 与系统 rg 都不可用）。' +
        '请安装系统 ripgrep（如 `apt install ripgrep` / `brew install ripgrep`）后重试。',
      { ...basePayload, error: 'rg_unavailable' },
    );
  }

  // ② 路径探测：Glob 只能枚举目录；不存在 / 不是目录 → 可诊断
  const probe = await probePath(searchPath);
  if (probe.kind === 'not_found') {
    return fail(
      `搜索路径 "${searchPath}" 不存在（ENOENT）。请核对路径：相对路径相对当前工作目录解析，` +
        '也可使用绝对路径；可先用 Glob 在更上层目录确认位置再重试。',
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
      error: 'not_a_directory',
    });
  }
  if (!probe.isDirectory) {
    return fail(
      `"${searchPath}" 不是目录，Glob 只能枚举目录下的文件。` +
        '若目标是单个文件，请用 Read 读取，或用 Grep 在文件内搜索。',
      { ...basePayload, error: 'not_a_directory' },
    );
  }

  // ③ 枚举：rg --files -g pattern，逐行收集（带收集上限）
  const rgArgs = [
    '--files',
    '--no-messages',
    '-g',
    args.pattern,
    '--',
    searchPath,
  ];
  const collected: string[] = [];
  let collectCapped = false;

  let runResult: Awaited<ReturnType<typeof runRgLines>>;
  try {
    runResult = await runRgLines(binary, rgArgs, {
      signal: ctx.signal,
      onLine: (line) => {
        const p = line.trim();
        if (p.length > 0) collected.push(p);
        if (collected.length >= runtime.collectCap) {
          collectCapped = true;
          return false;
        }
        return true;
      },
    });
  } catch (caught) {
    if (ctx.signal.aborted) throw caught; // 中断交给管线归一为「执行被中断」
    return fail(
      `rg 执行出错：${caught instanceof Error ? caught.message : String(caught)}`,
      { ...basePayload, error: 'rg_error' },
    );
  }

  if (ctx.signal.aborted) throw new Error('Glob 执行被中断');

  // ④ 未截断时按退出码分类：2 = rg 错误（含无效 glob），1 = 无匹配
  if (!runResult.stopped) {
    if (runResult.exitCode === 2) {
      const detail = runResult.stderr.trim();
      return fail(
        `rg 执行失败：${detail}\n可尝试：检查 glob 语法（如未闭合的 [ 或 {），或确认路径存在。`,
        { ...basePayload, error: 'rg_error', detail },
      );
    }
    if (runResult.exitCode === 1 || collected.length === 0) {
      return noMatchOutcome(basePayload, true);
    }
    if (runResult.exitCode !== 0) {
      return fail(`rg 异常终止（退出码 ${String(runResult.exitCode)}）。`, {
        ...basePayload,
        error: 'rg_error',
      });
    }
  }

  if (collected.length === 0) return noMatchOutcome(basePayload, true);

  // ⑤ stat + 按 mtime 降序排序（最新在前；平局按路径升序保证确定性）
  const withMtime = await Promise.all(
    collected.map(async (file) => {
      let mtimeMs = 0;
      try {
        const st = await stat(file);
        mtimeMs = st.mtimeMs;
      } catch {
        // stat 失败（枚举与读取之间文件消失等竞态）：mtime 按 0 排最后
      }
      return { file, mtimeMs };
    }),
  );
  withMtime.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file),
  );

  // ⑥ 按 maxResults 截断（截断要出声）
  const truncated = withMtime.length > maxResults;
  const files = truncated
    ? withMtime.slice(0, maxResults).map((entry) => entry.file)
    : withMtime.map((entry) => entry.file);
  const omittedFiles = truncated ? withMtime.length - maxResults : undefined;

  const payload: GlobPayload = {
    ...basePayload,
    totalFiles: withMtime.length,
    files,
    truncated,
    ...(omittedFiles !== undefined ? { omittedFiles } : {}),
    ...(collectCapped
      ? { collectCapped, collectCapFiles: runtime.collectCap }
      : {}),
  };
  const forModel = renderFiles(payload, maxResults);
  return {
    ok: true,
    forModel,
    summary:
      `Glob ${JSON.stringify(args.pattern)}：${files.length} 个文件` +
      (truncated ? `（共 ${withMtime.length} 个，已截断）` : ''),
    payload,
    ...(truncated ? { truncated: { truncated: true } } : {}),
  };
}

/** 构造 Glob 工具（可用选项覆盖默认值 / 注入 rg 解析；测试用）。 */
export function createGlobTool(
  options: GlobToolOptions = {},
): Tool<typeof globSchema> {
  const runtime: GlobRuntimeOptions = {
    defaultMaxResults: options.defaultMaxResults ?? DEFAULT_GLOB_MAX_RESULTS,
    collectCap: options.collectCap ?? GLOB_COLLECT_CAP,
    ...(options.rgOptions !== undefined
      ? { rgOptions: options.rgOptions }
      : {}),
    ...(options.findRg !== undefined ? { findRg: options.findRg } : {}),
  };
  return {
    name: 'glob',
    description:
      '按 glob 模式枚举目录下的文件，结果按修改时间排序（最新在前）。' +
      'pattern 必填（glob，如 "**/*.ts"、"src/*.ts"）；path 可选（默认当前工作目录，' +
      '相对路径相对 cwd 解析）；maxResults 可选（单次最多返回的文件数，默认 200）。' +
      '用于定位文件：先 Glob 找到文件名，再 Read 读取具体内容。' +
      'rg 默认尊重 .gitignore 并排除隐藏文件；超过上限会明确提示已截断。',
    schema: globSchema,
    risk: 'read',
    execute: (args: GlobArgs, ctx: ToolContext) =>
      executeGlob(args, ctx, runtime),
  };
}

/** 默认 Glob 工具实例（0.2.0 只读工具集之一）。 */
export const globTool: Tool<typeof globSchema> = createGlobTool();
