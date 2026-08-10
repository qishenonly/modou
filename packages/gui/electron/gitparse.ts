/**
 * git 输出解析（纯函数，可单测；不依赖 electron）。
 *
 * parseGitStatus 把 `git status --porcelain` 与两份 `--numstat`（unstaged /
 * staged）合并成变更条目列表：porcelain 提供 path + 状态，numstat 提供行数。
 */
import type { GitChangeEntry } from './ipc';

export type { GitChangeEntry };

/** numstat 单文件的增删行数。 */
interface NumstatCounts {
  readonly added: number;
  readonly deleted: number;
}

/** 解析一份 `git diff --numstat` 输出为 path → {added, deleted} 映射。 */
function parseNumstat(numstat: string): Map<string, NumstatCounts> {
  const map = new Map<string, NumstatCounts>();
  for (const line of numstat.split('\n')) {
    if (line.length === 0) continue;
    const firstTab = line.indexOf('\t');
    if (firstTab < 0) continue;
    const secondTab = line.indexOf('\t', firstTab + 1);
    if (secondTab < 0) continue;
    // path 可能含空格/制表符：取第二个 tab 之后的部分
    let path = line.slice(secondTab + 1);
    if (path.length === 0) continue;
    // 重命名 numstat 形如 `old => new`：取箭头后路径（对应 porcelain 的 `->`）
    const renameArrow = path.indexOf(' => ');
    if (renameArrow >= 0) path = path.slice(renameArrow + 4);
    // 二进制文件 numstat 是 `-\t-`，parseInt 得 NaN → 归 0
    const added = Number.parseInt(line.slice(0, firstTab), 10);
    const deleted = Number.parseInt(line.slice(firstTab + 1, secondTab), 10);
    map.set(path, {
      added: Number.isNaN(added) ? 0 : added,
      deleted: Number.isNaN(deleted) ? 0 : deleted,
    });
  }
  return map;
}

/**
 * 合并 porcelain 与 numstat 输出。
 * - porcelain 每行形如 `XY path`（XY 两位状态；`??` 未跟踪；重命名
 *   `R  old -> new` 取箭头后路径）；
 * - 行数优先 staged numstat、其次 unstaged，都没有给 0。
 */
export function parseGitStatus(
  porcelain: string,
  unstagedNumstat: string,
  stagedNumstat: string,
): GitChangeEntry[] {
  const unstaged = parseNumstat(unstagedNumstat);
  const staged = parseNumstat(stagedNumstat);
  const entries: GitChangeEntry[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.length === 0) continue;
    const status = line.slice(0, 2);
    let path = line.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4);
    const stats = staged.get(path) ?? unstaged.get(path);
    entries.push({
      path,
      status,
      staged: status[0] !== ' ' && status[0] !== '?',
      added: stats?.added ?? 0,
      deleted: stats?.deleted ?? 0,
    });
  }
  return entries;
}
