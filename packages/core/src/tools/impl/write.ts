import { randomUUID } from 'node:crypto';
import { chmod, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext, ToolOutcome } from '../types';

/**
 * Write 工具（T-030）：新建 / 覆盖文件。覆盖已有文件前要求两个条件同时成立：
 *   1) 参数显式同意覆盖（overwrite: true，默认 false 时拒绝覆盖已有文件）；
 *   2) 该文件在本会话中已被 Read 过（ctx.readFiles，防盲写覆盖）。
 *
 * 设计依据（docs/design/002-architecture.md 5.2 / 5.3 / 5.4）：
 * - 防盲写：目标已存在时必须确认「模型看过它」，否则模型可能在没看过现状的
 *   情况下用幻觉内容覆盖真实文件——这是编码 agent 最危险的误操作之一；
 * - 错误即数据：父目录不存在 / 父路径是文件 / 权限不足 / 路径是目录 /
 *   未显式同意覆盖 / 覆盖未读文件，全部返回 `ok:false` 的可诊断文本回喂模型
 *   自纠（含路径与建议），不抛异常；
 * - 原子写：先写同目录临时文件再 `rename`（同文件系统，rename 原子），中途
 *   失败不留半个文件，也不会在覆盖已有文件时留下写坏的窗口；
 * - 非常规文件拒绝：对 FIFO / 套接字 / 设备写入会阻塞挂起或产生不可预期行为，
 *   是真实事故源，探测到即拒绝；
 * - 输出治理：forModel 纯文本 + payload 结构化
 *   （{path, existed, bytesWritten, overwrite}）。
 *
 * 实现要点：`stat` 探测目标（存在？目录？非常规文件？）→ 覆盖保护检查 →
 * 新文件路径的父目录存在性检查 → 临时文件 + rename 原子落盘。
 */

/** Write 工具参数 schema（zod）：path / content 必填；overwrite 可选 boolean。 */
export const writeSchema = z.object({
  path: z.string().min(1, 'path 不能为空字符串'),
  content: z.string(),
  overwrite: z.boolean().optional(),
});

export type WriteArgs = z.infer<typeof writeSchema>;

/** Write 结构化载荷（成功与错误共用：错误时 error / parentDir 存在）。 */
export interface WritePayload {
  readonly path: string;
  /** 目标文件在写入前是否已存在。 */
  readonly existed: boolean;
  /** 实际写入的字节数（UTF-8）。 */
  readonly bytesWritten: number;
  /** 本次写入的有效 overwrite 值（未传时 false）。 */
  readonly overwrite: boolean;
  /** 错误码（成功时不存在）。 */
  readonly error?: string;
  /** 目标父目录（父目录相关错误时存在）。 */
  readonly parentDir?: string;
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

/**
 * 把 fs 错误映射为可诊断文本（路径 + 建议），含错误码。
 * 覆盖写路径与父目录检查路径共用，避免错误码散落各处。
 */
function fsErrorOutcome(
  path: string,
  parentDir: string,
  caught: unknown,
): ToolOutcome {
  const code = errorCode(caught);
  const message = caught instanceof Error ? caught.message : String(caught);

  if (code === 'ENOENT') {
    return fail(
      `无法写入 "${path}"：父目录 "${parentDir}" 不存在（ENOENT）。请先创建各级目录` +
        `（如用 Bash mkdir -p），或用 Glob 确认目标目录结构后再重试。`,
      { path, parentDir, error: 'parent_not_found' },
    );
  }
  if (code === 'ENOTDIR') {
    return fail(
      `无法写入 "${path}"：路径中的中间部分不是目录（ENOTDIR，中间路径上有文件` +
        `占位）。请修正路径后重试。`,
      { path, parentDir, error: 'parent_not_directory' },
    );
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return fail(
      `写入 "${path}" 被拒绝：权限不足（${code}）。请确认目标文件与其所在目录` +
        `具有写入权限后重试。`,
      { path, error: 'permission_denied' },
    );
  }
  if (code === 'EISDIR') {
    return fail(
      `"${path}" 是一个目录，Write 工具只能写文件。请换用文件路径后重试。`,
      { path, error: 'is_directory' },
    );
  }
  return fail(
    `写入 "${path}" 失败（${String(code ?? '未知错误')}）：${message}`,
    {
      path,
      error: 'write_failed',
    },
  );
}

/**
 * 原子写：先写同目录临时文件，再 rename 到目标。
 * 临时文件与目标同目录（同一文件系统，rename 才原子）；随机名避免并发冲突。
 * 失败时尽力清理临时文件，不留残留。导出供 Edit（T-031）等写工具复用。
 */
export async function writeFileAtomically(
  target: string,
  content: string,
  signal: AbortSignal,
  mode?: number,
): Promise<void> {
  const tmpPath = join(
    dirname(target),
    `.${basename(target)}.modou-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tmpPath, content, 'utf8');
    // 覆盖已有文件时保留原 mode（rename 替换 inode 会丢权限位）
    if (mode !== undefined) await chmod(tmpPath, mode);
    if (signal.aborted) throw new DOMException('写入已中断', 'AbortError');
    await rename(tmpPath, target);
  } catch (caught) {
    await rm(tmpPath, { force: true }).catch(() => {}); // 尽力清理，不掩盖原错误
    throw caught;
  }
}

/** 执行一次 Write（含全部保护检查与原子落盘）。 */
async function executeWrite(
  args: WriteArgs,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const cwd = ctx.cwd ?? process.cwd();
  const absPath = isAbsolute(args.path) ? args.path : resolve(cwd, args.path);
  const parentDir = dirname(absPath);
  const overwrite = args.overwrite ?? false;

  if (ctx.signal.aborted) {
    return fail(`写入 "${absPath}" 已中断（收到中止信号），未执行。`, {
      path: absPath,
      error: 'interrupted',
    });
  }

  // 1) 探测目标：存在？目录？非常规文件？
  let existed = false;
  let existedMode: number | undefined;
  try {
    const st = await stat(absPath);
    existed = true;
    existedMode = st.mode & 0o777;
    if (st.isDirectory()) {
      return fail(
        `"${absPath}" 是一个目录，Write 工具只能写文件。请换用文件路径` +
          `（目录操作非本工具职责）。`,
        { path: absPath, error: 'is_directory' },
      );
    }
    if (!st.isFile()) {
      return fail(
        `"${absPath}" 已存在但不是普通文件（可能是 FIFO / 套接字 / 设备）。` +
          `对这类文件写入会阻塞或产生不可预期行为，Write 已拒绝。请换用文件路径后重试。`,
        { path: absPath, error: 'not_regular_file' },
      );
    }
  } catch (caught) {
    if (errorCode(caught) !== 'ENOENT') {
      return fsErrorOutcome(absPath, parentDir, caught);
    }
    // ENOENT → 目标不存在，作为新文件处理
  }

  // 2) 覆盖保护：已有文件必须「显式同意覆盖 + 本会话已读过」
  if (existed) {
    if (!overwrite) {
      return fail(
        `文件 "${absPath}" 已存在，但参数未显式同意覆盖。若确认要覆盖，` +
          `请传 overwrite: true（并要求本会话已用 Read 读取过该文件，防盲写）。`,
        { path: absPath, error: 'exists_requires_overwrite' },
      );
    }
    // 已读检查：绝对路径或其符号链接最终目标（realpath）命中任一即可
    let readable = ctx.readFiles !== undefined && ctx.readFiles.has(absPath);
    if (!readable) {
      const real = await realpath(absPath).catch(() => absPath);
      readable = ctx.readFiles !== undefined && ctx.readFiles.has(real);
    }
    if (!readable) {
      return fail(
        `目标文件 "${absPath}" 已存在，且本会话尚未读取过该文件。为防止盲写覆盖，` +
          `请先用 Read 工具读取该文件，再以 overwrite: true 重试写入。`,
        { path: absPath, error: 'not_read_before_overwrite' },
      );
    }
  }

  // 3) 新文件路径：父目录必须已存在且是目录（覆盖路径的目标已存在，父目录必然存在）
  if (!existed) {
    let parentSt;
    try {
      parentSt = await stat(parentDir);
    } catch (caught) {
      const code = errorCode(caught);
      if (code === 'ENOENT') {
        return fail(
          `无法写入 "${absPath}"：父目录 "${parentDir}" 不存在。请先创建各级目录` +
            `（如用 Bash mkdir -p），或用 Glob 确认目标目录结构后再重试。`,
          { path: absPath, parentDir, error: 'parent_not_found' },
        );
      }
      if (code === 'ENOTDIR') {
        return fail(
          `无法写入 "${absPath}"：父路径 "${parentDir}" 不是目录（中间路径包含` +
            `文件）。请修正路径后重试。`,
          { path: absPath, parentDir, error: 'parent_not_directory' },
        );
      }
      return fsErrorOutcome(absPath, parentDir, caught);
    }
    if (!parentSt.isDirectory()) {
      return fail(
        `无法写入 "${absPath}"：父路径 "${parentDir}" 存在但不是目录。请修正路径后重试。`,
        { path: absPath, parentDir, error: 'parent_not_directory' },
      );
    }
  }

  // 4) 原子落盘：同目录临时文件 + rename（覆盖时保留原 mode）
  try {
    await writeFileAtomically(absPath, args.content, ctx.signal, existedMode);
  } catch (caught) {
    if (ctx.signal.aborted) {
      return fail(
        `写入 "${absPath}" 已中断（收到中止信号），目标文件未被改动。`,
        { path: absPath, error: 'interrupted' },
      );
    }
    return fsErrorOutcome(absPath, parentDir, caught);
  }

  const bytesWritten = Buffer.byteLength(args.content, 'utf8');
  return {
    ok: true,
    forModel: existed
      ? `已写入文件 "${absPath}"（覆盖已有文件，${bytesWritten} 字节；本会话已先读取过该文件）。`
      : `已写入文件 "${absPath}"（新建，${bytesWritten} 字节）。`,
    summary: `Write ${absPath}：${existed ? '覆盖' : '新建'} ${bytesWritten} 字节`,
    payload: { path: absPath, existed, bytesWritten, overwrite },
  };
}

/**
 * 默认 Write 工具实例（T-030，risk: write）。
 * 与 read/grep/glob 一起经 defaultWriteTools 装配为 0.3.0 工具集。
 */
export const writeTool: Tool<typeof writeSchema> = {
  name: 'write',
  description:
    '新建或覆盖文件。path 必填（相对当前工作目录或绝对路径）；content 必填（要写入的完整内容）；' +
    'overwrite 可选（boolean，默认 false）。新建文件直接成功；覆盖已有文件必须同时满足两个条件：' +
    '参数 overwrite: true，且本会话已用 Read 工具读取过该文件（防止盲写覆盖）。' +
    '写入为原子操作（临时文件 + rename），失败不会留下半个文件；' +
    '父目录不存在、路径是目录、权限不足都会返回可诊断错误。',
  schema: writeSchema,
  risk: 'write',
  execute: (args: WriteArgs, ctx: ToolContext) => executeWrite(args, ctx),
};
