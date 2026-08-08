/**
 * 快照策略离线测试（T-101）：触碰路径 / .gitignore / node_modules / 上限降级。
 *
 * 覆盖：
 * - 全量模式尊重工作树 .gitignore（忽略项不进影子仓库）；
 * - node_modules 缺省排除（即使 .gitignore 未声明）；
 * - 触碰路径模式：只快照指定路径（其余变更不进本次快照）；
 * - collectTouchedPaths：从会话日志收集 write/edit 成功调用的路径，read / 失败
 *   调用 / 失败 bash 不收集；任一成功 bash 调用 → 返回空集（回落全量快照）；
 * - 上限降级：变更路径数 / 单文件字节 / 总字节超限 → degraded 点（id null、不可还原）。
 *
 * 全部离线：临时项目 + 临时 HOME 隔离，不触碰真实用户目录。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTouchedPaths, SessionRecord, SnapshotStore } from '@modou/core';

/** 共享测试根目录（模块级创建，afterAll 清理）。 */
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'modou-snap-policy-'));

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

/** 快照点之间的树级 diff（新点相对旧点变动的路径）。 */
function changedPaths(
  store: SnapshotStore,
  fromId: string,
  toId: string,
): string[] {
  const out = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', fromId, toId],
    {
      encoding: 'utf8',
      cwd: store.snapshotsRoot,
      env: {
        ...process.env,
        GIT_DIR: store.gitDir,
        GIT_WORK_TREE: store.snapshotsRoot,
      },
    },
  );
  return out
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
}

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// .gitignore 尊重 / node_modules 排除
// ---------------------------------------------------------------------------

describe('.gitignore 尊重与 node_modules 排除（T-101）', () => {
  test('全量快照尊重工作树 .gitignore（忽略项不进影子仓库）', async () => {
    const { project, store } = makeIsolation();
    writeFileSync(join(project, '.gitignore'), '*.log\nbuild/\n', 'utf8');
    mkdirSync(join(project, 'build'), { recursive: true });
    writeFileSync(join(project, 'a.ts'), 'code\n', 'utf8');
    writeFileSync(join(project, 'debug.log'), 'log\n', 'utf8');
    writeFileSync(join(project, 'build', 'out.js'), 'built\n', 'utf8');

    const point = await store.snapshot();
    expect(point).not.toBeNull();
    expect(point?.filesChanged).toBe(2); // .gitignore + a.ts
    const tree = shadowGit(
      store,
      ['ls-tree', '-r', '--name-only', 'HEAD'],
      project,
    );
    expect(tree.trim().split('\n').sort()).toEqual(['.gitignore', 'a.ts']);
  });

  test('node_modules 缺省排除（即使 .gitignore 未声明）', async () => {
    const { project, store } = makeIsolation();
    mkdirSync(join(project, 'node_modules'), { recursive: true });
    writeFileSync(join(project, 'index.ts'), 'main\n', 'utf8');
    writeFileSync(join(project, 'node_modules', 'dep.js'), 'dep\n', 'utf8');

    const point = await store.snapshot();
    expect(point).not.toBeNull();
    expect(point?.filesChanged).toBe(1);
    const tree = shadowGit(
      store,
      ['ls-tree', '-r', '--name-only', 'HEAD'],
      project,
    );
    expect(tree.trim().split('\n')).toEqual(['index.ts']);
  });
});

// ---------------------------------------------------------------------------
// 触碰路径模式
// ---------------------------------------------------------------------------

describe('触碰路径模式（T-101）', () => {
  test('只快照指定路径：其余路径的变更不进本次快照', async () => {
    const { project, store } = makeIsolation();
    writeFileSync(join(project, 'a.txt'), '1\n', 'utf8');
    writeFileSync(join(project, 'b.txt'), '1\n', 'utf8');
    const baseline = await store.snapshot();
    expect(baseline?.id).not.toBeNull();
    const baselineId = baseline?.id as string;

    // 两个文件都改 + 新建 c.txt，但只快照 a.txt
    writeFileSync(join(project, 'a.txt'), '2\n', 'utf8');
    writeFileSync(join(project, 'b.txt'), '2\n', 'utf8');
    writeFileSync(join(project, 'c.txt'), 'new\n', 'utf8');
    const point = await store.snapshot({ paths: [join(project, 'a.txt')] });
    expect(point).not.toBeNull();
    expect(point?.filesChanged).toBe(1);

    // 本次快照只捕获 a.txt 的变更
    const changed = changedPaths(store, baselineId, point?.id as string);
    expect(changed).toEqual(['a.txt']);
    // b.txt / c.txt 内容在影子仓库仍是旧版 / 不存在
    expect(shadowGit(store, ['show', `${point?.id}:a.txt`], project)).toBe(
      '2\n',
    );
    expect(shadowGit(store, ['show', `${point?.id}:b.txt`], project)).toBe(
      '1\n',
    );
    expect(
      shadowGit(
        store,
        ['ls-tree', '-r', '--name-only', point?.id as string],
        project,
      ),
    ).not.toContain('c.txt');
  });

  test('触碰路径无变更时返回 null（不产生空 commit）', async () => {
    const { project, store } = makeIsolation();
    writeFileSync(join(project, 'a.txt'), '1\n', 'utf8');
    await store.snapshot();
    // 其他文件变了，但触碰路径 a.txt 没变
    writeFileSync(join(project, 'other.txt'), 'x\n', 'utf8');
    const point = await store.snapshot({ paths: [join(project, 'a.txt')] });
    expect(point).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// collectTouchedPaths
// ---------------------------------------------------------------------------

describe('collectTouchedPaths（T-101 从会话日志收集）', () => {
  test('收集 write/edit 成功调用的路径；read / 失败调用 / 失败 bash 不收集', () => {
    const cwd = '/tmp/fake-project';
    const records: SessionRecord[] = [
      {
        seq: 1,
        ts: 1,
        kind: 'assistant',
        data: {
          text: '',
          calls: [
            {
              id: 'w1',
              name: 'write',
              input: { path: 'src/a.ts', content: 'x' },
            },
            {
              id: 'e1',
              name: 'edit',
              input: { path: 'src/b.ts', old: '1', new: '2' },
            },
            { id: 'r1', name: 'read', input: { path: 'src/c.ts' } },
            {
              id: 'f1',
              name: 'write',
              input: { path: 'src/d.ts', content: 'y' },
            },
            { id: 's1', name: 'bash', input: { command: 'touch x.sh' } },
          ],
        },
      },
      {
        seq: 2,
        ts: 2,
        kind: 'tool_result',
        data: {
          callId: 'w1',
          ok: true,
          forModel: 'ok',
          payload: { path: '/tmp/fake-project/src/a.ts' },
        },
      },
      {
        seq: 3,
        ts: 3,
        kind: 'tool_result',
        data: {
          callId: 'e1',
          ok: true,
          forModel: 'ok',
          payload: { path: '/tmp/fake-project/src/b.ts' },
        },
      },
      {
        seq: 4,
        ts: 4,
        kind: 'tool_result',
        data: { callId: 'r1', ok: true, forModel: 'ok' },
      },
      {
        seq: 5,
        ts: 5,
        kind: 'tool_result',
        data: { callId: 'f1', ok: false, forModel: 'failed' },
      },
      {
        seq: 6,
        ts: 6,
        kind: 'tool_result',
        data: { callId: 's1', ok: false, forModel: 'failed' }, // bash 失败不算触碰
      },
    ];
    const touched = collectTouchedPaths(records, { cwd });
    expect(touched).toEqual([
      '/tmp/fake-project/src/a.ts',
      '/tmp/fake-project/src/b.ts',
    ]);
  });

  test('任一成功 bash 调用 → 返回空集（调用方回落全量快照），与 write/edit 混用亦然', () => {
    const cwd = '/tmp/fake-project';
    const records: SessionRecord[] = [
      {
        seq: 1,
        ts: 1,
        kind: 'assistant',
        data: {
          text: '',
          calls: [
            {
              id: 'w1',
              name: 'write',
              input: { path: 'src/a.ts', content: 'x' },
            },
            {
              id: 's1',
              name: 'bash',
              input: { command: 'mv src/a.ts src/b.ts' },
            },
          ],
        },
      },
      {
        seq: 2,
        ts: 2,
        kind: 'tool_result',
        data: {
          callId: 'w1',
          ok: true,
          forModel: 'ok',
          payload: { path: '/tmp/fake-project/src/a.ts' },
        },
      },
      {
        seq: 3,
        ts: 3,
        kind: 'tool_result',
        data: { callId: 's1', ok: true, forModel: 'ok' },
      },
    ];
    // 即使有成功的 write，任一成功 bash 也令收集结果为空集 → 全量快照兜底
    expect(collectTouchedPaths(records, { cwd })).toEqual([]);
  });

  test('payload 缺省时从调用入参相对 cwd 解析；无写调用返回空集', () => {
    const records: SessionRecord[] = [
      {
        seq: 1,
        ts: 1,
        kind: 'assistant',
        data: {
          text: '',
          calls: [{ id: 'w1', name: 'write', input: { path: 'rel/file.ts' } }],
        },
      },
      {
        seq: 2,
        ts: 2,
        kind: 'tool_result',
        data: { callId: 'w1', ok: true, forModel: 'ok' },
      },
    ];
    expect(collectTouchedPaths(records, { cwd: '/proj' })).toEqual([
      '/proj/rel/file.ts',
    ]);
    // 只有只读调用 → 空集（调用方回落全量快照）
    expect(collectTouchedPaths([], { cwd: '/proj' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 上限降级
// ---------------------------------------------------------------------------

describe('上限降级（T-101：超限仅记录 diff 摘要并告警）', () => {
  test('变更路径数超限 → degraded 点（id null，不可还原）', async () => {
    const { project, store } = makeIsolation();
    writeFileSync(join(project, 'a.txt'), '1\n', 'utf8');
    writeFileSync(join(project, 'b.txt'), '1\n', 'utf8');
    await store.snapshot();
    // 两个文件变更，上限 1 → 降级
    writeFileSync(join(project, 'a.txt'), '2\n', 'utf8');
    writeFileSync(join(project, 'b.txt'), '2\n', 'utf8');
    const point = await store.snapshot({ limits: { maxChangedPaths: 1 } });
    expect(point).not.toBeNull();
    expect(point?.degraded).toBe(true);
    expect(point?.id).toBeNull();
    expect(point?.reason).toContain('变更路径数 2 超过上限 1');
    // 影子仓库没有新的 commit（内容仍是基线）
    const list = await store.listSnapshots();
    expect(list[0]?.degraded).toBe(true);
  });

  test('单文件字节超限 → 降级（影子仓库不存超大文件）', async () => {
    const { project, store } = makeIsolation();
    writeFileSync(join(project, 'big.bin'), 'x'.repeat(2000), 'utf8');
    const point = await store.snapshot({ limits: { maxSingleFileBytes: 100 } });
    expect(point?.degraded).toBe(true);
    expect(point?.reason).toContain('超过单文件上限');
  });

  test('变更总字节超限 → 降级', async () => {
    const { project, store } = makeIsolation();
    writeFileSync(join(project, 'a.txt'), 'x'.repeat(600), 'utf8');
    const point = await store.snapshot({ limits: { maxBytes: 500 } });
    expect(point?.degraded).toBe(true);
    expect(point?.reason).toContain('超过上限');
  });

  test('degraded 点不产生影子 commit，后续快照仍可正常进行', async () => {
    const { project, store } = makeIsolation();
    writeFileSync(join(project, 'a.txt'), '1\n', 'utf8');
    const first = await store.snapshot();
    expect(first?.degraded).toBe(false);
    // 大文件触发降级
    writeFileSync(join(project, 'huge.bin'), 'x'.repeat(5000), 'utf8');
    const degraded = await store.snapshot({
      limits: { maxSingleFileBytes: 100 },
    });
    expect(degraded?.degraded).toBe(true);
    // 删除大文件后恢复
    execFileSync('rm', [join(project, 'huge.bin')]);
    writeFileSync(join(project, 'a.txt'), '2\n', 'utf8');
    const restored = await store.snapshot();
    expect(restored).not.toBeNull();
    expect(restored?.degraded).toBe(false);
    expect(restored?.filesChanged).toBe(1);
  });

  test('degraded 点返回前 manifest 已落盘（saveManifest await，写竞态修复）', async () => {
    const { project, store } = makeIsolation();
    writeFileSync(join(project, 'a.txt'), '1\n', 'utf8');
    await store.snapshot();
    writeFileSync(join(project, 'big.bin'), 'x'.repeat(5000), 'utf8');
    const degraded = await store.snapshot({
      limits: { maxSingleFileBytes: 100 },
    });
    expect(degraded?.degraded).toBe(true);
    // 直接读 manifest 文件：degraded 点必须在 snapshot() 返回时已持久化
    const manifest = JSON.parse(readFileSync(store.manifestPath, 'utf8')) as Array<{
      id: string | null;
      degraded: boolean;
    }>;
    expect(manifest).toHaveLength(2);
    expect(manifest[1]?.degraded).toBe(true);
    expect(manifest[1]?.id).toBeNull();
  });
});
