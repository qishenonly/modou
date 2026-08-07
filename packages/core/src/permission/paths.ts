import { lstatSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { PermissionConfig } from './policy';

/**
 * 目录边界（T-051，design 002 6.2 / kickoff 0.5.0 3.2）。
 *
 * 路径校验必须在**规范化之后**做，且是「解析真实路径再判断前缀」而非字符串比较：
 * 展开 `~`、解析 `..`、**跟随符号链接到最终目标**（realpath）、转绝对路径，然后判断
 * 是否落在工作区根（projectRoot）或 `--add-dir` 白名单（addDirs）内。符号链接逃逸是
 * 这类工具最经典的漏洞——工作区里放一个指向 `/etc` 的软链，字符串前缀比较直接就被
 * 绕过；本模块的 realpath 归一使 `workspace/link/passwd`（link → /etc）解析为
 * `/etc/passwd` → 越界。
 *
 * 语义说明：
 * - `~` / `~/...` 展开为家目录（`~user` 形式不支持，保持字面量——日常路径极少用，
 *   且展开错误比保持字面量更危险）；
 * - 相对路径按工作区根（projectRoot）解析（`resolve` 文本归一，与写工具
 *   `resolve(cwd, path)` 的解析方式一致，两侧不会分歧）；绝对路径保持原样，其中的
 *   `..` 由自实现的 realpath 按 **POSIX 语义**处理——`..` 相对**符号链接的目标**
 *   而非文本父目录（如 `link/../x` 中 link → /etc 时等价 `/x`）。这里**不能**用
 *   `fs.realpathSync`：Node 的实现会先文本折叠 `..`（`link/..` 折叠成工作区本身），
 *   与内核的路径解析不一致——工作区里放 `link → /etc` 的软链后，`link/../x` 在内核
 *   眼里是 `/x`（工作区外），Node 却判成工作区内，这是可实际利用的逃逸；
 * - 目标不存在（写入新文件）时：逐组件解析到「第一个不存在的组件」，此后进入字面
 *   尾段（`..` 依旧弹出真实目录栈，`.` 跳过，其余按组件追加）——尾段不含符号链接，
 *   文本归一是安全的；
 * - 根（projectRoot / addDirs）自身也做同样的 realpath 归一：根是符号链接时（如
 *   --add-dir 指向 /tmp 这类软链目录）与目标同基准比较，两侧一致才不会漏判 / 误判；
 * - 校验失败（路径不可解析：权限不足等）按**越界**处理（fail-closed），并带 reason
 *   可诊断。
 *
 * 本模块用同步 fs（lstat / readlink）而非 fs/promises：decidePermission 是同步裁决
 * （ApprovalGate 在 ask 之前直通 allow/deny，不引入异步），目录边界是裁决路径上的
 * 一步，几个 lstat 调用是微秒级，不值得为它把整个权限内核改成 async。
 */

/** 边界校验失败原因（ok=false 时存在；outside 时 ok 仍为 true）。 */
export type BoundaryReason =
  /** 路径为空字符串 / 全空白，无法判定。 */
  | 'empty_path'
  /** projectRoot 未配置，目录边界无基准。 */
  | 'missing_root'
  /** 目标真实路径无法解析（权限不足等），fail-closed 视同越界。 */
  | 'unresolvable'
  /** realpath 归一后位于工作区 / 白名单之外。 */
  | 'outside';

/** 目录边界校验结果。 */
export interface AllowedPathResult {
  /** 校验是否完成（false = 配置缺失 / 路径不可解析等前置失败）。 */
  readonly ok: boolean;
  /** 目标是否落在工作区或 --add-dir 白名单内（ok=false 时为 false）。 */
  readonly inside: boolean;
  /** realpath 归一后的最终目标（绝对路径，跟随符号链接；解析失败时为原始输入）。 */
  readonly realPath: string;
  /** 命中的根（realpath 归一后的 projectRoot 或 addDirs 项；未命中时不存在）。 */
  readonly allowedRoot?: string;
  /** 失败原因（ok=false 或越界时存在）。 */
  readonly reason?: BoundaryReason;
  /** 可诊断详情（门控 / 日志用）。 */
  readonly detail?: string;
}

/** realpath 可判定「路径不存在」的系统错误码（其余如 EACCES 按不可解析处理）。 */
const NONE_EXISTENT_CODES = new Set([
  'ENOENT',
  'ENOTDIR',
  'EINVAL',
  'ENAMETOOLONG',
]);

/** fs 错误是否属于「路径不存在」类（可沿父目录继续向上找）。 */
function isNonexistentError(caught: unknown): boolean {
  if (typeof caught !== 'object' || caught === null) return false;
  const code = (caught as { readonly code?: unknown }).code;
  return typeof code === 'string' && NONE_EXISTENT_CODES.has(code);
}

/**
 * 展开 `~` / `~/...` 为家目录绝对路径（`~user` 不支持，见文件头注释）。
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** 符号链接跟随深度上限（POSIX SYMLOOP_MAX），防链接环把解析挂死。 */
const MAX_SYMLINKS = 40;

/**
 * 解析真实路径（跟随符号链接到最终目标）。
 *
 * 自实现而非 `fs.realpathSync`：Node 的实现会先文本折叠 `..`，与内核路径解析
 * 不一致（见文件头注释）。本实现逐组件解析，维护「真实目录栈」：
 * - `.` 跳过；`..` 弹出真实栈顶（相对真实目录，而非文本父目录）；
 * - 组件是符号链接时读目标：绝对目标从根重新解析，相对目标相对链接所在真实目录
 *   解析，目标组件回到队列继续处理（链接跟随深度受 MAX_SYMLINKS 约束）；
 * - 组件不存在（写入新文件）时进入字面尾段：剩余组件继续按真实栈追加 / 弹栈。
 *
 * 返回 null = 不可解析（权限不足等，调用方按越界处理）。
 */
export function resolveRealPathSync(path: string): string | null {
  if (path.length === 0) return null;
  // 相对路径先文本归一（resolve），与写工具 resolve(cwd, path) 一致；绝对路径
  // 保持原样，其中 `..` 由下面的逐组件解析按 POSIX 语义处理。
  const abs = isAbsolute(path) ? path : resolve(path);
  const queue: string[] = abs.split(/[\\/]+/).filter((s) => s.length > 0);
  const real: string[] = []; // 真实目录栈：空 = '/'
  let links = 0;

  while (queue.length > 0) {
    const seg = queue.shift() as string;
    if (seg === '.') continue;
    if (seg === '..') {
      // `..` 相对真实目录：弹出真实栈顶（在根目录时停留在根）
      if (real.length > 0) real.pop();
      continue;
    }
    const current = real.length === 0 ? `/${seg}` : `/${real.join('/')}/${seg}`;

    let isLink = false;
    let isNonexistent = false;
    let otherError = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (caught) {
      if (isNonexistentError(caught)) isNonexistent = true;
      else otherError = true; // EACCES 等 → 不可解析（fail-closed）
    }
    if (otherError) return null;

    if (isNonexistent) {
      // 第一个不存在的组件：进入字面尾段（剩余组件不含符号链接，文本归一安全）
      real.push(seg);
      for (const tailSeg of queue) {
        if (tailSeg === '.') continue;
        if (tailSeg === '..') {
          if (real.length > 0) real.pop();
          continue;
        }
        real.push(tailSeg);
      }
      break;
    }

    if (isLink) {
      if (++links > MAX_SYMLINKS) return null; // 链接环 → 不可解析
      const target = readlinkSync(current);
      const linkDir = real.length === 0 ? '/' : `/${real.join('/')}`;
      // 相对目标相对链接所在真实目录解析；绝对目标从根重新解析
      const targetAbs = isAbsolute(target) ? target : resolve(linkDir, target);
      real.length = 0; // 链接目标替换此前缀
      queue.unshift(...targetAbs.split(/[\\/]+/).filter((s) => s.length > 0));
      continue;
    }

    // 普通目录 / 文件：入真实栈
    real.push(seg);
  }

  return real.length === 0 ? '/' : `/${real.join('/')}`;
}

/** 一个根（projectRoot / addDirs 项）的 realpath 归一：不可解析时退回文本规范化。 */
export function normalizeRoot(root: string): string {
  const expanded = expandHome(root);
  const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
  return resolveRealPathSync(abs) ?? abs;
}

/** 前缀判定：target == root，或以「root + 分隔符」开头（防 /repo2 误命中 /repo）。 */
export function isWithinRoot(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * 目录边界校验主入口：展开 `~` → 转绝对（相对路径按工作区根解析）→ realpath 跟随
 * 符号链接到最终目标，然后判断是否落在 `config.projectRoot`（工作区）或
 * `config.addDirs`（--add-dir 白名单）内。
 *
 * - `inside: true` → 目标在工作区内，可放行；
 * - `inside: false`（ok 仍为 true，reason 'outside'）→ 越界，调用方应转 ask / deny；
 * - `ok: false` → 配置缺失 / 路径不可解析，fail-closed 视同越界。
 */
export function resolveAllowedPath(
  path: string,
  config: PermissionConfig,
): AllowedPathResult {
  if (path.trim().length === 0) {
    return {
      ok: false,
      inside: false,
      realPath: path,
      reason: 'empty_path',
      detail: '路径为空字符串（无法做边界校验）',
    };
  }
  if (
    typeof config.projectRoot !== 'string' ||
    config.projectRoot.trim().length === 0
  ) {
    return {
      ok: false,
      inside: false,
      realPath: path,
      reason: 'missing_root',
      detail: 'PermissionConfig.projectRoot 未配置（目录边界无基准）',
    };
  }

  const expanded = expandHome(path);
  const abs = isAbsolute(expanded)
    ? expanded
    : resolve(config.projectRoot, expanded);
  const realPath = resolveRealPathSync(abs);
  if (realPath === null) {
    return {
      ok: false,
      inside: false,
      realPath: abs,
      reason: 'unresolvable',
      detail: `无法解析目标真实路径（可能权限不足）：${abs}`,
    };
  }

  // 与工作区根 / --add-dir 白名单比对（两侧 realpath 归一，防根自身是符号链接）
  const roots = [config.projectRoot, ...(config.addDirs ?? [])].map(
    normalizeRoot,
  );
  for (const root of roots) {
    if (isWithinRoot(realPath, root)) {
      return { ok: true, inside: true, realPath, allowedRoot: root };
    }
  }
  return {
    ok: true,
    inside: false,
    realPath,
    reason: 'outside',
    detail: `${realPath} 不在工作区（${config.projectRoot}）或 --add-dir 白名单内`,
  };
}
