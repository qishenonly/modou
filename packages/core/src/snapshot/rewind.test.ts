/**
 * 回滚离线测试（T-102）：多快照点还原 / 保留未触碰文件 / 手动改动提示差异。
 *
 * 覆盖：
 * - 多快照点：还原到任意中间点，文件内容与该点一致；
 * - 还原后新增文件被删除、未触碰（影子未跟踪）文件原样保留；
 * - 符号链接与权限在还原时保留（git 存 symlink / mode）；
 * - 用户手动改过的已跟踪文件在回滚预览里提示差异（overwriteFiles）；
 * - 还原后影子 HEAD 移到目标点，后续快照正常继续。
 *
 * 全部离线：临时项目 + 临时 HOME 隔离，不触碰真实用户目录。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '@modou/core';

/** 共享测试根目录（模块级创建，afterAll 清理）。 */
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'modou-snap-rewind-'));

/** 创建临时项目 + 临时 HOME。 */
function makeIsolation(): {
  project: string;
  store: SnapshotStore;
} {
  const root = mkdtempSync(join(TEST_ROOT, 'case-'));
  const project = join(root, 'proj');
  mkdirSync(project, { recursive: true });
  const store = new SnapshotStore({
    homeDir: join(root, 'home'),
    cwd: project,
  });
  return { project, store };
}

/** 在影子仓库里跑 git 读命令。 */
function shadowGit(store: SnapshotStore, args: string[], cwd: string): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, GIT_DIR: store.gitDir, GIT_WORK_TREE: cwd },
  });
}

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/** 构造三快照点的经典场景：P0（初始）→ P1（改 a + 新建 c）→ P2（改 a + 改 b）。 */
async function buildThreePoints(): Promise<{
  project: string;
  store: SnapshotStore;
  p0: string;
  p1: string;
  p2: string;
}> {
  const { project, store } = makeIsolation();
  writeFileSync(join(project, 'a.txt'), '1\n', 'utf8');
  writeFileSync(join(project, 'b.txt'), '1\n', 'utf8');
  const p0 = (await store.snapshot())?.id as string;

  writeFileSync(join(project, 'a.txt'), '2\n', 'utf8');
  writeFileSync(join(project, 'c.txt'), 'new\n', 'utf8');
  const p1 = (await store.snapshot())?.id as string;

  writeFileSync(join(project, 'a.txt'), '3\n', 'utf8');
  writeFileSync(join(project, 'b.txt'), '2\n', 'utf8');
  const p2 = (await store.snapshot())?.id as string;

  return { project, store, p0, p1, p2 };
}

describe('多快照点还原到任意中间点（T-102）', () => {
  test('还原到中间点：文件内容回到该点、之后新增的文件被删除', async () => {
    const { project, store, p0, p1, p2 } = await buildThreePoints();

    // 还原到 P1（中间点）：a=2、c 存在、b 仍是 1（P1 时 b 未动）
    const result1 = await store.rewindTo(p1);
    expect(result1.restored).toContain('a.txt');
    expect(result1.restored).toContain('b.txt');
    expect(result1.deleted).toEqual([]); // c 在 P1 已存在，不删
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('2\n');
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('1\n');
    expect(readFileSync(join(project, 'c.txt'), 'utf8')).toBe('new\n');
    // 影子 HEAD 已移到 P1
    expect(result1.headId).toBe(p1);

    // 还原到 P0（初始点）：a=1、c 是 P1 新增 → 被删除
    await store.rewindTo(p0);
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('1\n');
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('1\n');
    expect(() => readFileSync(join(project, 'c.txt'), 'utf8')).toThrow();

    // 再还原到 P2（HEAD 已移到 P0，仍可还原更新的快照——对象仍在）
    await store.rewindTo(p2);
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('3\n');
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('2\n');
    expect(readFileSync(join(project, 'c.txt'), 'utf8')).toBe('new\n');
  });

  test('未触碰（影子未跟踪）文件原样保留', async () => {
    const { project, store, p0 } = await buildThreePoints();
    // 用户自己的文件：从未进影子仓库
    writeFileSync(join(project, 'user-owned.txt'), 'mine\n', 'utf8');
    // 触碰路径快照：只快照 a.txt（user-owned 不进影子）
    writeFileSync(join(project, 'a.txt'), 'agent\n', 'utf8');
    await store.snapshot({ paths: [join(project, 'a.txt')] });

    await store.rewindTo(p0);
    expect(readFileSync(join(project, 'user-owned.txt'), 'utf8')).toBe(
      'mine\n',
    );
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('1\n');
  });

  test('符号链接与文件权限在还原时保留', async () => {
    const { project, store } = makeIsolation();
    writeFileSync(join(project, 'target.txt'), 'data\n', 'utf8');
    execFileSync('ln', ['-s', 'target.txt', join(project, 'link.txt')]);
    execFileSync('chmod', ['+x', join(project, 'target.txt')]);
    const p0 = (await store.snapshot())?.id as string;

    writeFileSync(join(project, 'target.txt'), 'data2\n', 'utf8');
    execFileSync('chmod', ['-x', join(project, 'target.txt')]);
    await store.snapshot();

    // 还原到 P0：target 内容与可执行位回到 P0、link 仍是符号链接
    await store.rewindTo(p0);
    expect(readFileSync(join(project, 'target.txt'), 'utf8')).toBe('data\n');
    const mode = execFileSync(
      'stat',
      ['-c', '%A', join(project, 'target.txt')],
      {
        encoding: 'utf8',
      },
    ).trim();
    expect(mode.startsWith('-rwx')).toBe(true);
    const linkTarget = execFileSync('readlink', [join(project, 'link.txt')], {
      encoding: 'utf8',
    }).trim();
    expect(linkTarget).toBe('target.txt');
    // 影子仓库里 link 是 symlink（mode 120000）
    const tree = shadowGit(store, ['ls-tree', 'HEAD', 'link.txt'], project);
    expect(tree.startsWith('120000')).toBe(true);
  });

  test('还原后影子 HEAD 移到目标点，后续快照正常继续', async () => {
    const { project, store, p0 } = await buildThreePoints();
    await store.rewindTo(p0);
    // 还原后继续工作：改 a 并快照 → 新点从 P0 状态继续
    writeFileSync(join(project, 'a.txt'), 'post-rewind\n', 'utf8');
    const next = await store.snapshot();
    expect(next).not.toBeNull();
    expect(shadowGit(store, ['show', `${next?.id}:a.txt`], project)).toBe(
      'post-rewind\n',
    );
    // 历史仍是线性（新点直接跟在 P0 之后）
    const log = shadowGit(store, ['log', '--oneline'], project);
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(2); // 新点 + P0（P1/P2 已不在分支上）
    expect(lines[0]).toContain('modou 快照');
    expect(lines[1]).toContain('modou 快照');
  });
});

describe('回滚预览：手动改动提示差异（T-102）', () => {
  test('用户手动改过的已跟踪文件出现在 overwriteFiles', async () => {
    const { project, store, p0 } = await buildThreePoints();
    // 用户手动修改 a.txt（工作树与影子 HEAD=P2 不同）
    writeFileSync(join(project, 'a.txt'), 'user-manual\n', 'utf8');

    const preview = await store.previewRewind(p0);
    expect(preview.snapshotId).toBe(p0);
    expect(preview.restoreFiles).toContain('a.txt');
    expect(preview.overwriteFiles).toContain('a.txt'); // 手动改动 → 提示差异
    expect(preview.deleteFiles).toContain('c.txt');
  });

  test('无手动改动时 overwriteFiles 为空（agent 改动属正常还原）', async () => {
    const { store, p0 } = await buildThreePoints();
    const preview = await store.previewRewind(p0);
    expect(preview.overwriteFiles).toEqual([]);
    expect(preview.restoreFiles.length).toBeGreaterThan(0);
  });

  test('还原到 degraded / 不存在的快照报错', async () => {
    const { store } = await buildThreePoints();
    await expect(store.rewindTo('deadbeef'.repeat(5))).rejects.toThrow(
      /不存在/,
    );
  });
});
