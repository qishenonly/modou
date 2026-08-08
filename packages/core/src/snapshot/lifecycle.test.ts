/**
 * 快照生命周期离线测试（T-103）：过期清理 / 保留策略 / 占用报告。
 *
 * 覆盖：
 * - 按时间窗口清理：超过 maxAgeMs 且不在「每会话最近 N 条」保护集的快照被移除；
 * - 每会话保留下限：keepPerSession 保护最近 N 条（不被时间窗口误删）；
 * - 每项目上限：maxPerProject 超限删最旧；
 * - 清理重写影子历史：被删 commit 不在分支上（git log 只剩保留的）；
 * - 占用报告：快照数 / 降级数 / 字节 / 最近时间。
 *
 * 全部离线：临时项目 + 临时 HOME 隔离，时钟注入（不依赖真实时间）。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '@modou/core';

/** 共享测试根目录（模块级创建，afterAll 清理）。 */
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'modou-snap-lifecycle-'));

/** 带可推进时钟的隔离项目（now 由调用方手动推进，快照 ts 据此注入）。 */
function makeClockStore(retention: Record<string, number>): {
  project: string;
  store: SnapshotStore;
  advance: (ms: number) => void;
} {
  const root = mkdtempSync(join(TEST_ROOT, 'case-'));
  const project = join(root, 'proj');
  mkdirSync(project, { recursive: true });
  let now = 1_000_000;
  const store = new SnapshotStore({
    homeDir: join(root, 'home'),
    cwd: project,
    now: () => now,
    retention,
  });
  return { project, store, advance: (ms) => (now += ms) };
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

describe('过期清理（T-103）', () => {
  test('超过时间窗口且不在保护集的快照被移除，最近点保留', async () => {
    const { project, store, advance } = makeClockStore({
      maxAgeMs: 1500,
      keepPerSession: 2,
      maxPerProject: 10,
    });
    writeFileSync(join(project, 'a.txt'), '1\n', 'utf8');
    await store.snapshot({ sessionId: 'sess-a' }); // ts = 1_000_000
    advance(1000);
    writeFileSync(join(project, 'a.txt'), '2\n', 'utf8');
    await store.snapshot({ sessionId: 'sess-a' }); // ts = 1_001_000
    advance(1000);
    writeFileSync(join(project, 'a.txt'), '3\n', 'utf8');
    await store.snapshot({ sessionId: 'sess-a' }); // ts = 1_002_000

    const before = await store.listSnapshots();
    expect(before).toHaveLength(3);

    const result = await store.cleanup();
    expect(result.removed).toBe(1); // 最早的（1_000_000，距今 2000 > 1500）
    expect(result.kept).toBe(2);
    expect(result.freedBytes).toBeGreaterThanOrEqual(0);

    const after = await store.listSnapshots();
    expect(after).toHaveLength(2);
    expect(after[0]?.ts).toBe(1_002_000);
    expect(after[1]?.ts).toBe(1_001_000);
    // 影子历史只剩保留的 commit
    const log = shadowGit(store, ['log', '--format=%s'], project);
    expect(log.trim().split('\n')).toHaveLength(2);
  });

  test('keepPerSession 保护每会话最近 N 条（不被时间窗口误删）', async () => {
    const { project, store, advance } = makeClockStore({
      maxAgeMs: 1500, // 时间窗口：超过即过期（除非被 keepPerSession 保护）
      keepPerSession: 2,
      maxPerProject: 10,
    });
    for (const sessionId of ['sess-a', 'sess-b']) {
      writeFileSync(join(project, `${sessionId}.txt`), '1', 'utf8');
      await store.snapshot({ sessionId }); // ts = T
      advance(1000);
      writeFileSync(join(project, `${sessionId}.txt`), '2', 'utf8');
      await store.snapshot({ sessionId }); // ts = T+1000
      advance(1000);
      writeFileSync(join(project, `${sessionId}.txt`), '3', 'utf8');
      await store.snapshot({ sessionId }); // ts = T+2000
      advance(1000);
    }
    // now 停在最后一个快照之后 1000ms：每条最早的快照距今 3000ms > 1500，
    // 但每会话最近 2 条受保护保留 → 各移除最早 1 条
    const result = await store.cleanup();
    expect(result.removed).toBe(2);
    expect(result.kept).toBe(4);
    const after = await store.listSnapshots();
    expect(after).toHaveLength(4);
    // 每会话都保留了最近 2 条
    const sessionA = after.filter((entry) => entry.sessionId === 'sess-a');
    const sessionB = after.filter((entry) => entry.sessionId === 'sess-b');
    expect(sessionA).toHaveLength(2);
    expect(sessionB).toHaveLength(2);
  });

  test('maxPerProject 超限删最旧', async () => {
    const { project, store, advance } = makeClockStore({
      maxAgeMs: 0,
      keepPerSession: 10,
      maxPerProject: 3,
    });
    for (let index = 1; index <= 5; index += 1) {
      writeFileSync(join(project, 'a.txt'), `${index}`, 'utf8');
      await store.snapshot({ sessionId: 'sess-a' });
      advance(10);
    }
    const result = await store.cleanup();
    expect(result.removed).toBe(2);
    expect(result.kept).toBe(3);
    const after = await store.listSnapshots();
    expect(after[0]?.ts).toBe(1_000_040); // 最新的 3 条保留
    expect(after[2]?.ts).toBe(1_000_020);
  });
});

describe('占用报告（T-103 /snapshots）', () => {
  test('reportUsage 统计快照数 / 降级数 / 字节 / 最近时间', async () => {
    const { project, store } = makeClockStore({});
    writeFileSync(join(project, 'a.txt'), '1\n', 'utf8');
    await store.snapshot({ sessionId: 'sess-a' });
    writeFileSync(join(project, 'a.txt'), '2\n', 'utf8');
    await store.snapshot({ sessionId: 'sess-a' });
    // 一次降级（超单文件上限）
    writeFileSync(join(project, 'huge.bin'), 'x'.repeat(5000), 'utf8');
    await store.snapshot({ limits: { maxSingleFileBytes: 100 } });

    const usage = await store.reportUsage();
    expect(usage.totalBytes).toBeGreaterThan(0);
    const current = usage.projects.find(
      (projectReport) => projectReport.projectHash === store.projectHash,
    );
    expect(current).toBeDefined();
    expect(current?.snapshotCount).toBe(2); // 可还原
    expect(current?.degradedCount).toBe(1); // 降级
    expect(current?.lastTs).toBeGreaterThan(0);
    expect(current?.retention.maxAgeMs).toBeGreaterThan(0); // 生效的缺省策略
  });

  test('无快照项目时占用报告为空', async () => {
    const { store } = makeClockStore({});
    const usage = await store.reportUsage();
    expect(usage.projects).toEqual([]);
    expect(usage.totalBytes).toBe(0);
  });
});
