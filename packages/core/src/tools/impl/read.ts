import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { ToolRegistry } from '../registry';
import type { Tool, ToolContext, ToolOutcome } from '../types';

/**
 * Read 工具（T-021）：读取文件并按行号展示，支持 offset/limit 分页。
 *
 * 设计依据（docs/design/002-architecture.md 5.2 / 5.3 / 5.4）：
 * - 错误即数据：文件不存在 / 是目录 / 无权限 / 二进制 / 过大，全部返回
 *   `ok:false` 的可诊断文本回喂模型自纠，不抛异常；
 * - 大文件保护：行数跨过阈值仍未到文件尾时进入「大文件模式」，只按
 *   offset/limit 读页面、不统计全文件行数（避免整读）；字节数超过硬上限
 *   直接拒绝读取，提示用 Grep 定位；
 * - 二进制识别：流式读取时探测 NUL / 硬控制字节（不误伤 UTF-8 中文），
 *   命中即拒绝输出（防乱码）；
 * - 输出治理：forModel 纯文本 + payload 结构化（{path,totalLines,lines:[…]}），
 *   截断 / 脱敏交给管线（T-020）；工具自报 truncated（还有更多行，分页省略）。
 *
 * 实现要点：createReadStream + StringDecoder 单遍流式处理，内存有界——
 * 只保留「页面行 + 半行缓冲」，对任意大小文件都能以固定内存读取指定页。
 */

/** 未传 limit 时的默认分页行数。 */
export const DEFAULT_READ_LIMIT = 200;
/** limit 上限：单次读取最多行数，超出请缩小范围分页读取。 */
export const READ_LIMIT_MAX = 2_000;
/** 字节硬上限：文件超过即拒绝读取（连分页也不读），提示用 Grep 定位。 */
export const READ_MAX_BYTES = 100 * 1024 * 1024;
/** 行数阈值：流式读取跨过它仍未到文件尾，即进入大文件模式。 */
export const READ_LARGE_FILE_LINES = 50_000;
/** 流式读取块大小（字节）。 */
const CHUNK_SIZE = 64 * 1024;

/** Read 工具参数 schema（zod）：path 必填；offset/limit 可选正整数。 */
export const readSchema = z.object({
  path: z.string().min(1, 'path 不能为空字符串'),
  offset: z
    .number()
    .int('offset 必须是整数')
    .positive('offset 必须是正整数（起始行号，1-based）')
    .optional(),
  limit: z
    .number()
    .int('limit 必须是整数')
    .positive('limit 必须是正整数')
    .max(
      READ_LIMIT_MAX,
      `limit 最大支持 ${READ_LIMIT_MAX} 行，超出请缩小范围分页读取`,
    )
    .optional(),
});

export type ReadArgs = z.infer<typeof readSchema>;

/** 工具选项：允许测试与特化场景覆盖默认阈值。 */
export interface ReadToolOptions {
  /** 未传 limit 时的分页行数。默认 200。 */
  readonly defaultLimit?: number;
  /** 字节硬上限。默认 100 MiB。 */
  readonly maxBytes?: number;
  /** 行数阈值（进入大文件模式）。默认 50_000。 */
  readonly largeFileLines?: number;
}

/** 流式读取一页的结果。 */
interface ReadPageResult {
  /** 精确总行数；大文件模式未统计到文件尾时为 null。 */
  readonly totalLines: number | null;
  /** 已扫描的行数（正常模式 === totalLines；大文件模式 = 提前停止处）。 */
  readonly scannedLines: number;
  readonly binary: boolean;
  readonly largeFile: boolean;
  readonly lines: ReadonlyArray<{
    readonly line: number;
    readonly text: string;
  }>;
  /** 页面之后是否还有更多行。 */
  readonly hasMore: boolean;
}

/** 解析后的运行时选项（默认值已展开）。 */
interface ReadRuntimeOptions {
  readonly defaultLimit: number;
  readonly maxBytes: number;
  readonly largeFileLines: number;
}

/**
 * 二进制启发式：是否存在「硬控制字节」。
 * 选 0x00–0x08 与 0x0E–0x1F：这些字节在合法 UTF-8 文本中不会出现（多字节
 * 序列的续 / 首字节都 ≥ 0x80），命中即大概率是二进制；同时不会误伤中文等
 * 多字节 UTF-8 文本。0x09 TAB / 0x0A LF / 0x0D CR 常见于文本，不在此列。
 * 对每个 chunk 都调用，防止后续块含控制字节的文件漏网。
 */
function detectHardControl(buf: Buffer): boolean {
  for (const byte of buf) {
    if (byte <= 0x08 || (byte >= 0x0e && byte <= 0x1f)) return true;
  }
  return false;
}

/** 清理行文本：剥掉 CRLF 的 \r 与首行 BOM（﻿）。 */
function displayText(raw: string, isFirstLine: boolean): string {
  let text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (isFirstLine && text.startsWith('\uFEFF')) text = text.slice(1);
  return text;
}

/** 字节数的人类可读格式。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} 字节`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 流式读取文件的一个行段（[offset, offset+limit)），并统计行数。
 *
 * 单遍处理：createReadStream 逐块解码（StringDecoder 正确处理跨块多字节
 * 字符），只保留「页面行 + 半行缓冲」，内存与文件大小无关。
 *
 * 提前停止条件（大文件保护 / 二进制）：
 * - 页面已读满（currentLine >= pageEnd）且已跨过行数阈值 → 大文件模式，
 *   不再读后续行（不整读），totalLines 返回 null；
 * - 探测到二进制 → 立即停止，不再读。
 */
async function readFilePage(
  filePath: string,
  offset: number,
  limit: number,
  largeFileLines: number,
  signal: AbortSignal | undefined,
): Promise<ReadPageResult> {
  const pageEnd = offset + limit - 1;
  const page: Array<{ line: number; text: string }> = [];
  let currentLine = 0;
  let binary = false;
  let largeFile = false;
  let reachedEof = false;

  const stream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
  const decoder = new StringDecoder('utf8');
  let pending = '';

  const onAbort = (): void => {
    stream.destroy();
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      stream.destroy();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    for await (const rawChunk of stream) {
      const chunk = rawChunk as Buffer;
      // 每个 chunk 都做二进制探测（硬控制字节 + NUL），防止
      // 「首块纯文本、后续块含控制字节」的文件漏网 dump 乱码
      if (detectHardControl(chunk) || chunk.indexOf(0) !== -1) {
        binary = true;
      }
      if (binary) break; // 二进制文件无需继续读

      const text = decoder.write(chunk);
      const pieces = text.split('\n');
      const tail = pieces.pop() ?? '';
      for (const piece of pieces) {
        currentLine += 1;
        if (currentLine >= offset && currentLine <= pageEnd) {
          page.push({
            line: currentLine,
            text: displayText(pending + piece, currentLine === 1),
          });
        }
        pending = '';
      }
      pending += tail;

      // 大文件保护：页面已读满且越过行数阈值 → 提前停止，不整读
      if (currentLine >= pageEnd && currentLine > largeFileLines) {
        largeFile = true;
        break;
      }
    }
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    stream.destroy();
  }

  if (!largeFile && !binary) {
    pending += decoder.end();
    if (pending.length > 0) {
      currentLine += 1;
      if (currentLine >= offset && currentLine <= pageEnd) {
        page.push({
          line: currentLine,
          text: displayText(pending, currentLine === 1),
        });
      }
    }
    reachedEof = true;
  }

  return {
    totalLines: reachedEof ? currentLine : null,
    scannedLines: currentLine,
    binary,
    largeFile,
    lines: page,
    hasMore: largeFile || (reachedEof && currentLine > pageEnd),
  };
}

/** 失败结果（错误即数据）：payload 携带结构化错误码供前端渲染。 */
function fail(forModel: string, payload?: unknown): ToolOutcome {
  return payload === undefined
    ? { ok: false, forModel }
    : { ok: false, forModel, payload };
}

/** 把 fs 错误映射为可诊断文本（路径 + 建议），含错误码。 */
function fileErrorOutcome(path: string, caught: unknown): ToolOutcome {
  const code =
    typeof caught === 'object' && caught !== null && 'code' in caught
      ? (caught as { readonly code?: unknown }).code
      : undefined;
  const message = caught instanceof Error ? caught.message : String(caught);

  if (code === 'ENOENT') {
    return fail(
      `文件 "${path}" 不存在（ENOENT）。请核对路径：相对路径相对当前工作目录解析，也可使用绝对路径；可先用 Glob 确认文件名再重试。`,
      { path, error: 'not_found' },
    );
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return fail(
      `读取 "${path}" 被拒绝：权限不足（${code}）。请确认该文件可读（含所在目录的遍历权限）后重试。`,
      { path, error: 'permission_denied' },
    );
  }
  return fail(
    `读取 "${path}" 失败（${String(code ?? '未知错误')}）：${message}`,
    { path, error: 'read_failed' },
  );
}

/** 渲染成功结果：forModel 纯文本 + 给人看的 summary。 */
function renderPage(
  path: string,
  result: ReadPageResult,
  totalBytes: number,
  offset: number,
  largeFileLines: number,
): {
  readonly text: string;
  readonly summary: string;
  readonly nextOffset: number | null;
} {
  const lines = result.lines;
  const lastLine = lines.length > 0 ? lines[lines.length - 1].line : offset - 1;
  const nextOffset = result.hasMore ? offset + lines.length : null;
  const rangeText = lines.length > 0 ? `${offset}–${lastLine}` : String(offset);
  const width = Math.max(1, String(lastLine).length);
  const body = lines
    .map((entry) => `${String(entry.line).padStart(width)} | ${entry.text}`)
    .join('\n');
  const sizeText = formatBytes(totalBytes);

  if (result.largeFile) {
    return {
      text:
        `文件 "${path}"（总大小 ${sizeText}）\n` +
        `已显示第 ${rangeText} 行。\n` +
        `文件较大（已扫描至少 ${result.scannedLines} 行，超过 ${largeFileLines} 行的大文件阈值，未统计全部行数）：` +
        `为避免整读大文件，仅按 offset/limit 读取页面。\n` +
        `更多行在第 ${nextOffset} 行起：继续用 offset=${nextOffset} 读取同一文件即可。\n` +
        `──\n${body}`,
      summary: `Read ${path}：第 ${rangeText} 行（大文件，未统计全部行数）`,
      nextOffset,
    };
  }

  if (lines.length === 0) {
    return {
      text: `文件 "${path}"（0 行 · 0 字节）\n文件为空。`,
      summary: `Read ${path}：空文件`,
      nextOffset: null,
    };
  }

  if (!result.hasMore) {
    return {
      text:
        `文件 "${path}"（共 ${result.totalLines} 行 · ${sizeText}）\n` +
        `已显示第 ${rangeText} 行（全部内容）。\n` +
        `──\n${body}`,
      summary: `Read ${path}：第 ${rangeText} 行 / 共 ${result.totalLines} 行`,
      nextOffset: null,
    };
  }

  return {
    text:
      `文件 "${path}"（共 ${result.totalLines} 行 · ${sizeText}）\n` +
      `已显示第 ${rangeText} 行。\n` +
      `更多行在第 ${nextOffset} 行起：继续用 offset=${nextOffset} 读取同一文件即可。\n` +
      `──\n${body}`,
    summary: `Read ${path}：第 ${rangeText} 行 / 共 ${result.totalLines} 行（还有更多）`,
    nextOffset,
  };
}

/** 执行一次 Read（由 createReadTool 闭包注入运行时选项）。 */
async function executeRead(
  args: ReadArgs,
  ctx: ToolContext,
  options: ReadRuntimeOptions,
): Promise<ToolOutcome> {
  const cwd = ctx.cwd ?? process.cwd();
  const absPath = isAbsolute(args.path) ? args.path : resolve(cwd, args.path);
  const offset = args.offset ?? 1;
  const limit = args.limit ?? options.defaultLimit;

  // 先 stat：字节硬上限拒绝 + 目录 / 非普通文件识别（无需打开文件）
  let fileStat: Stats;
  try {
    fileStat = await stat(absPath);
  } catch (caught) {
    return fileErrorOutcome(absPath, caught);
  }

  if (fileStat.size > options.maxBytes) {
    return fail(
      `文件 "${absPath}" 过大（${formatBytes(fileStat.size)}，超过上限 ${formatBytes(options.maxBytes)}），Read 已拒绝读取。建议用 Grep 定位目标内容，或先裁剪文件再读。`,
      {
        path: absPath,
        error: 'too_large',
        size: fileStat.size,
        maxBytes: options.maxBytes,
      },
    );
  }
  if (fileStat.isDirectory()) {
    return fail(
      `"${absPath}" 是一个目录，Read 工具只能读取文件。如需查看目录内容，请使用 Glob 工具。`,
      { path: absPath, error: 'is_directory' },
    );
  }
  if (!fileStat.isFile()) {
    return fail(
      `"${absPath}" 不是普通文件（可能是设备 / 管道 / 套接字），无法用 Read 读取。`,
      { path: absPath, error: 'not_regular_file' },
    );
  }

  // 流式读取页面（单遍：提取页面 + 计数行数，内存有界）
  let result: ReadPageResult;
  try {
    result = await readFilePage(
      absPath,
      offset,
      limit,
      options.largeFileLines,
      ctx.signal,
    );
  } catch (caught) {
    if (ctx.signal.aborted) throw caught; // 中断交给管线归一为「执行被中断」
    return fileErrorOutcome(absPath, caught);
  }

  if (result.binary) {
    return fail(
      `文件 "${absPath}" 疑似二进制（检测到 NUL / 控制字节），已拒绝输出以免显示乱码。可尝试：用 Grep 在文件内定位目标文本；或查看文件头部确认格式。`,
      { path: absPath, error: 'binary' },
    );
  }

  // 空文件：不报越界，给出友好提示
  if (result.totalLines === 0) {
    const rendered = renderPage(
      absPath,
      result,
      fileStat.size,
      offset,
      options.largeFileLines,
    );
    return {
      ok: true,
      forModel: rendered.text,
      summary: rendered.summary,
      payload: {
        path: absPath,
        totalLines: result.totalLines,
        totalBytes: fileStat.size,
        offset,
        limit,
        lines: result.lines,
        largeFile: false,
        truncated: false,
        nextOffset: null,
      },
    };
  }

  // 越界检查：offset 超出有效范围（1..totalLines）
  if (result.totalLines !== null && offset > result.totalLines) {
    return fail(
      `参数越界：文件 "${absPath}" 共 ${result.totalLines} 行，offset=${offset} 超出有效范围（1..${result.totalLines}）。请调小 offset 后重试。`,
      {
        path: absPath,
        error: 'offset_out_of_range',
        totalLines: result.totalLines,
        offset,
      },
    );
  }

  const rendered = renderPage(
    absPath,
    result,
    fileStat.size,
    offset,
    options.largeFileLines,
  );
  return {
    ok: true,
    forModel: rendered.text,
    summary: rendered.summary,
    payload: {
      path: absPath,
      totalLines: result.totalLines,
      totalBytes: fileStat.size,
      offset,
      limit,
      lines: result.lines,
      largeFile: result.largeFile,
      truncated: result.hasMore,
      nextOffset: rendered.nextOffset,
    },
    ...(result.hasMore
      ? {
          truncated: {
            truncated: true,
            ...(result.totalLines !== null
              ? {
                  omittedLines: Math.max(
                    0,
                    result.totalLines - result.lines.length,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
}

/** 构造 Read 工具（可用选项覆盖默认阈值；测试用）。 */
export function createReadTool(
  options: ReadToolOptions = {},
): Tool<typeof readSchema> {
  const runtime: ReadRuntimeOptions = {
    defaultLimit: options.defaultLimit ?? DEFAULT_READ_LIMIT,
    maxBytes: options.maxBytes ?? READ_MAX_BYTES,
    largeFileLines: options.largeFileLines ?? READ_LARGE_FILE_LINES,
  };
  return {
    name: 'read',
    description:
      '读取本地文件内容，按行号展示（默认前 200 行），用于查看代码、配置与文档的具体内容。' +
      'path 必填（相对当前工作目录或绝对路径）；offset 为起始行号（1-based，默认 1）；' +
      'limit 为读取行数（默认 200，最大 2000）。读取结果带行号；文件较大时会说明文件大小并提示分页' +
      '（更多行在第 X 行起，用 offset 继续）；二进制文件会自动拒绝输出。',
    schema: readSchema,
    risk: 'read',
    execute: (args: ReadArgs, ctx: ToolContext) =>
      executeRead(args, ctx, runtime),
  };
}

/** 默认 Read 工具实例（0.2.0 只读工具集之一）。 */
export const readTool: Tool<typeof readSchema> = createReadTool();

/**
 * 便捷装配：把 read 加入一个工具注册表（T-023 系统提示词工具集用它起步）。
 * 缺省创建新注册表；传入已有注册表时幂等（已有 read 则跳过，不重复注册）。
 */
export function defaultReadTools(
  registry: ToolRegistry = new ToolRegistry(),
): ToolRegistry {
  if (!registry.has(readTool.name)) registry.register(readTool);
  return registry;
}
