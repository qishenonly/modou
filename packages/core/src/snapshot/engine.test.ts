/**
 * 快照引擎离线测试（T-100）：影子 git 快照。
 *
 * 覆盖：
 * - 快照创建：影子仓库生成、manifest 落盘、id / 摘要正确；
 * - 内容正确：影子 commit 里的文件与工作树一致（ls-tree + show）；
 * - 用户仓库零影响：快照前后用户的 git status / staged / HEAD / 分支完全不变；
 * - 非 git 项目同样可用（影子仓库独立 init）；
 * - 无变更返回 null（不产生空 commit）；
 * - listSnapshots 按时间倒序。
 *
 * 全部离线：临时项目 + 临时 HOME 隔离，不触碰真实用户目录。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectHash, SnapshotStore } from '@modou/core';

// ---------------------------------------------------------------------------
// 测试替身：git 命令封装（与 engine 同口径，验证影子仓库内容）
// ---------------------------------------------------------------------------

/** 在影子仓库里跑一条 git 命令（读侧），返回 stdout。 */
function shadowGit(store: SnapshotStore, args: string[], cwd: string): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, GIT_DIR: store.gitDir, GIT_WORK_TREE: cwd },
  });
}

/** 共享测试根目录（模块级创建，afterAll 清理）。 */
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'modou-snap-'));

/** 创建临时项目 + 临时 HOME，返回隔离句柄。 */
function makeIsolation(): {
  project: string;
  homeDir: string;
  store: SnapshotStore;
} {
  const root = mkdtempSync(join(TEST_ROOT, 'case-'));
  const project = join(root, 'proj');
  const homeDir = join(root, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const store = new SnapshotStore({ homeDir, cwd: project });
  return { project, homeDir, store };
}

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 快照创建与内容正确
// ---------------------------------------------------------------------------

describe('快照创建与内容正确（T-100）', () => {
  test('snapshot 生成影子仓库 + manifest，内容与工作树一致', async () => {
    const { project, store } = makeIsolation();
    mkdirSync(join(project, 'sub'), { recursive: true });
    writeFileSync(join(project, 'a.txt'), 'AAA\n', 'utf8');
    writeFileSync(join(project, 'sub', 'b.txt'), 'BBB\n', 'utf8');

    const point = await store.snapshot();
    expect(point).not.toBeNull();
    expect(point?.id).not.toBeNull();
    expect(point?.filesChanged).toBe(2);
    expect(point?.summary).toContain('2 个文件变更');
    expect(point?.degraded).toBe(false);
    expect(point?.projectHash).toBe(projectHash(project));

    // 影子仓库存在
    expect(existsSync(join(store.gitDir, 'HEAD'))).toBe(true);
    // manifest 落盘
    const manifest = JSON.parse(
      readFileSync(store.manifestPath, 'utf8'),
    ) as Array<{ id: string | null }>;
    expect(manifest).toHaveLength(1);
    expect(point?.id).toEqual(manifest[0]?.id);

    // 内容正确：ls-tree 列出文件
    const tree = shadowGit(
      store,
      ['ls-tree', '-r', '--name-only', 'HEAD'],
      project,
    );
    expect(tree.trim().split('\n').sort()).toEqual(['a.txt', 'sub/b.txt']);
    // 内容正确：show 读取每个文件
    expect(shadowGit(store, ['show', `${point?.id}:a.txt`], project)).toBe(
      'AAA\n',
    );
    expect(shadowGit(store, ['show', `${point?.id}:sub/b.txt`], project)).toBe(
      'BBB\n',
    );
  });

  test('无变更时 snapshot 返回 null（不产生空 commit）', async () => {
    const { project, store } = makeIsolation();
    writeFileSync(join(project, 'a.txt'), 'x', 'utf8');
    const first = await store.snapshot();
    expect(first).not.toBeNull();
    const second = await store.snapshot();
    expect(second).toBeNull();
    // manifest 仍只有一条
    const manifest = JSON.parse(readFileSync(store.manifestPath, 'utf8'));
    expect(manifest).toHaveLength(1);
  });

  test('listSnapshots 按时间倒序（新 → 旧）', async () => {
    const { project, store } = makeIsolation();
    writeFileSync(join(project, 'a.txt'), '1', 'utf8');
    await store.snapshot();
    writeFileSync(join(project, 'a.txt'), '2', 'utf8');
    await store.snapshot();
    writeFileSync(join(project, 'a.txt'), '3', 'utf8');
    await store.snapshot();
    const points = await store.listSnapshots();
    expect(points).toHaveLength(3);
    expect(points[0]?.ts).toBeGreaterThanOrEqual(points[1]?.ts ?? 0);
    expect(points[1]?.ts).toBeGreaterThanOrEqual(points[2]?.ts ?? 0);
    // 内容逐步演进
    const id0 = points[2]?.id as string;
    const id2 = points[0]?.id as string;
    expect(shadowGit(store, ['show', `${id0}:a.txt`], project)).toBe('1');
    expect(shadowGit(store, ['show', `${id2}:a.txt`], project)).toBe('3');
  });
});

// ---------------------------------------------------------------------------
// 用户仓库零影响
// ---------------------------------------------------------------------------

describe('用户仓库零影响（T-100 验收门）', () => {
  test('快照前后用户的 git status / staged / HEAD / 分支完全不变', async () => {
    const { project, store } = makeIsolation();
    // 用户仓库：一个已提交文件 + 一个已暂存文件 + 一个未跟踪文件
    execFileSync('git', ['init', '-q', '-b', 'main', project]);
    execFileSync('git', ['-C', project, 'config', 'user.name', 'tester']);
    execFileSync('git', ['-C', project, 'config', 'user.email', 't@local']);
    writeFileSync(join(project, 'committed.txt'), 'committed\n', 'utf8');
    execFileSync('git', ['-C', project, 'add', 'committed.txt']);
    execFileSync('git', ['-C', project, 'commit', '-qm', 'init']);
    writeFileSync(join(project, 'staged.txt'), 'staged\n', 'utf8');
    execFileSync('git', ['-C', project, 'add', 'staged.txt']);
    writeFileSync(join(project, 'untracked.txt'), 'untracked\n', 'utf8');

    const capture = (): Record<string, string> => ({
      status: execFileSync('git', ['-C', project, 'status', '--porcelain'], {
        encoding: 'utf8',
      }),
      cached: execFileSync(
        'git',
        ['-C', project, 'diff', '--cached', '--name-only'],
        { encoding: 'utf8' },
      ),
      head: execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }),
      branch: execFileSync('git', ['-C', project, 'branch', '--show-current'], {
        encoding: 'utf8',
      }),
      log: execFileSync('git', ['-C', project, 'log', '--oneline'], {
        encoding: 'utf8',
      }),
    });

    const before = capture();
    // 快照：全量模式，把用户仓库的工作树文件（含 staged/untracked）都记录到影子仓库
    const point = await store.snapshot();
    expect(point).not.toBeNull();
    const after = capture();

    expect(after).toEqual(before);
    expect(after.status).toContain('staged.txt'); // 用户的 staged 原样保留
    expect(after.status).toContain('untracked.txt');
    expect(after.cached.trim()).toBe('staged.txt');
  });

  test('非 git 项目同样可用（影子仓库独立 init）', async () => {
    const { project, store } = makeIsolation();
    writeFileSync(join(project, 'plain.txt'), 'plain', 'utf8');
    const point = await store.snapshot();
    expect(point).not.toBeNull();
    expect(
      shadowGit(store, ['ls-tree', '-r', '--name-only', 'HEAD'], project)
        .trim()
        .split('\n'),
    ).toEqual(['plain.txt']);
  });
});
