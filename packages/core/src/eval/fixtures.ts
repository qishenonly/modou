import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * fixture 仓库管理（T-035）。
 *
 * 铁律：**评测不能在仓库原地改文件**——每次运行前把 fixture 复制到新的临时目录，
 * 模型在副本上干活，判定也在副本上进行；仓库内的 fixture 是只读模板。
 */

/**
 * fixture 根目录（packages/core/src/eval/fixtures）。
 * 用 `import.meta.url` 而非 Bun 专属的 `import.meta.dir`：core 需在 Node/Electron
 * （GUI 主进程 bundle 进 core）与 Bun 双运行时下可加载，`fileURLToPath(new URL(...))`
 * 是两者都支持的跨运行时写法。
 */
export const FIXTURES_ROOT = fileURLToPath(
  new URL('./fixtures', import.meta.url),
);

/** 列出所有可用 fixture 目录名（排序稳定，评测报告用）。 */
export async function listFixtures(): Promise<string[]> {
  const entries = await readdir(FIXTURES_ROOT);
  const names: string[] = [];
  for (const entry of entries) {
    const entryStat = await stat(join(FIXTURES_ROOT, entry));
    if (entryStat.isDirectory()) names.push(entry);
  }
  return names.sort();
}

/** 校验 fixture 目录存在。 */
export async function fixtureExists(name: string): Promise<boolean> {
  try {
    const entryStat = await stat(join(FIXTURES_ROOT, name));
    return entryStat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 把 fixture 仓库复制到一个新的临时目录，返回该目录绝对路径。
 * 目录名带 fixture 名（`modou-eval-<name>-<random>`），便于调试时定位。
 * 调用方负责清理（`removeTempDir`，或交给 runEval 的 cleanup 选项）。
 */
export async function copyFixture(name: string): Promise<string> {
  const source = join(FIXTURES_ROOT, name);
  if (!(await fixtureExists(name))) {
    throw new Error(`fixture 不存在：${name}（期望目录 ${source}）`);
  }
  const dest = await mkdtemp(join(tmpdir(), `modou-eval-${name}-`));
  await cp(source, dest, { recursive: true });
  return dest;
}

/** 递归删除一个临时目录（评测运行后的清理；不存在时静默）。 */
export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
