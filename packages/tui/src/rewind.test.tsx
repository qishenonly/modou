/**
 * /rewind 快照选择器测试（T-102）：组件渲染 / 键盘 / runTui 集成。
 *
 * 覆盖：
 * - SnapshotPicker 列表态：渲染快照点（短哈希 / 时间 / 摘要），↑/↓ + Enter 选择、
 *   数字键直接选择、Esc 取消；
 * - 确认态：展示还原 / 删除 / 覆盖差异，Enter 确认、Esc 返回列表；
 * - runTui 集成：/rewind 列出快照点并打开选择器（轮次运行中拒绝）。
 *
 * 全部离线：stub provider（不访问外网），homeDir 用临时目录隔离，快照用真实
 * 影子 git（临时项目）。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import type {
  ModelProvider,
  PermissionConfig,
  ProviderCapabilities,
  RewindPreview,
  SessionReadResult,
  SnapshotPoint,
  StreamChatInput,
  StreamEvent,
} from '@modou/core';
import {
  defaultWriteTools,
  projectHash,
  SessionStore,
  SnapshotStore,
} from '@modou/core';
import type { TuiOptions } from './startup';
import { SnapshotPicker } from './rewind';
import { runTui } from './index';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

class FakeStdout extends EventEmitter {
  get columns(): number {
    return 100;
  }

  get rows(): number {
    return 50;
  }

  readonly frames: string[] = [];
  private last?: string;

  write = (frame: string): void => {
    this.frames.push(frame);
    this.last = frame;
  };

  lastFrame = (): string => this.last ?? '';
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;

  write = (data: string): void => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}

  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

class StubProvider implements ModelProvider {
  readonly id = 'openai-compat';
  readonly capabilities: ProviderCapabilities = {
    maxContext: 128_000,
    parallelToolCalls: false,
    cacheBreakpoints: false,
    images: false,
    thinking: 'none',
    strictJsonArgs: true,
  };

  constructor(readonly modelId: string) {}

  async *streamChat(_input: StreamChatInput): AsyncIterable<StreamEvent> {
    void _input; // 参数签名与 ModelProvider 一致；本 stub 不需要读请求内容
    yield { type: 'text_delta', delta: '回复' };
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } };
    yield { type: 'finish', reason: 'stop' };
  }
}

/** 多轮 stub：按调用顺序消费 rounds；用尽后重放最后一轮（工具循环测试用）。 */
class RoundsStubProvider implements ModelProvider {
  readonly id = 'openai-compat';
  readonly capabilities: ProviderCapabilities = {
    maxContext: 128_000,
    parallelToolCalls: false,
    cacheBreakpoints: false,
    images: false,
    thinking: 'none',
    strictJsonArgs: true,
  };
  private callCount = 0;

  constructor(
    readonly modelId: string,
    private readonly rounds: readonly StreamEvent[][],
  ) {}

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    void input;
    const round = this.rounds[Math.min(this.callCount, this.rounds.length - 1)];
    this.callCount += 1;
    if (round === undefined) return;
    for (const event of round) yield event;
  }
}

/** 轮询直到 probe 返回非 null（异步），超时抛错。 */
async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setTimeout(resolve, 40));
}

async function typeAndEnter(stdin: FakeStdin, text: string): Promise<void> {
  stdin.write(text);
  await flush();
  stdin.write('\r');
  await flush();
}

async function startTui(options: TuiOptions): Promise<{
  stdout: FakeStdout;
  stdin: FakeStdin;
  exit: Promise<{ exitCode: number }>;
}> {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const signalEmitter = new EventEmitter();
  const exit = runTui({
    homeDir: options.homeDir,
    cwd: options.cwd ?? options.homeDir,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    signalEmitter,
    ...options,
  });
  await flush();
  return { stdout, stdin, exit };
}

afterAll(() => {
  cleanup();
  rmSync(ROOT, { recursive: true, force: true });
});

/** 共享测试根目录（模块级创建，afterAll 清理）。 */
const ROOT = mkdtempSync(join(tmpdir(), 'modou-tui-rewind-'));

/** 在共享根下建一个隔离子目录。 */
function makeHome(): string {
  const dir = mkdtempSync(join(ROOT, 'case-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// SnapshotPicker 组件
// ---------------------------------------------------------------------------

const FAKE_POINTS: readonly SnapshotPoint[] = [
  {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ts: 1_700_000_000_000,
    message: 'modou 快照',
    summary: '2 个文件变更：a.ts(修改)、b.ts(新增)',
    filesChanged: 2,
    projectHash: 'proj1',
    degraded: false,
  },
  {
    id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ts: 1_700_000_060_000,
    message: 'modou 快照',
    summary: '1 个文件变更：c.ts(修改)',
    filesChanged: 1,
    projectHash: 'proj1',
    degraded: false,
  },
];

describe('SnapshotPicker（T-102 /rewind 组件）', () => {
  test('列表态渲染快照点（短哈希 / 摘要），Enter 选择首项', async () => {
    const selected: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <SnapshotPicker
        candidates={FAKE_POINTS}
        onSelect={(id) => selected.push(id)}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('快照点（/rewind）');
    expect(frame).toContain('aaaaaaaa'); // 8 位短哈希
    expect(frame).toContain('2 个文件变更');
    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write('\r'); // Enter 选择首项 → onSelect
    expect(selected).toEqual([FAKE_POINTS[0]?.id as string]);
    unmount();
  });

  test('数字键直接选择对应快照点', async () => {
    const selected: string[] = [];
    const { stdin, unmount } = render(
      <SnapshotPicker
        candidates={FAKE_POINTS}
        onSelect={(id) => selected.push(id)}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write('2');
    expect(selected).toEqual([FAKE_POINTS[1]?.id as string]);
    unmount();
  });

  test('↑/↓ 移动选中项，Enter 选择移动后的项', async () => {
    const selected: string[] = [];
    const { stdin, unmount } = render(
      <SnapshotPicker
        candidates={FAKE_POINTS}
        onSelect={(id) => selected.push(id)}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write('\x1b[B'); // ↓（0 → 1）
    stdin.write('\r');
    expect(selected).toEqual([FAKE_POINTS[1]?.id as string]);
    unmount();
  });

  test('确认态展示差异，Enter 确认还原', async () => {
    const preview: RewindPreview = {
      snapshotId: FAKE_POINTS[0]?.id as string,
      restoreFiles: ['a.ts', 'b.ts'],
      deleteFiles: ['c.ts'],
      overwriteFiles: ['a.ts'], // 手动改动 → 覆盖警告
    };
    let confirmed = 0;
    const { lastFrame, stdin, unmount } = render(
      <SnapshotPicker
        candidates={FAKE_POINTS}
        preview={preview}
        onSelect={() => {}}
        onConfirm={() => (confirmed += 1)}
        onCancel={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('还原到快照 aaaaaaaa');
    expect(frame).toContain('将还原 2 个文件');
    expect(frame).toContain('删除 1 个文件');
    expect(frame).toContain('警告');
    expect(frame).toContain('a.ts');
    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write('\r');
    expect(confirmed).toBe(1);
    unmount();
  });

  test('确认态 Esc 返回列表（onCancel）', async () => {
    let cancelled = 0;
    const { stdin, unmount } = render(
      <SnapshotPicker
        candidates={FAKE_POINTS}
        preview={{
          snapshotId: FAKE_POINTS[0]?.id as string,
          restoreFiles: ['a.ts'],
          deleteFiles: [],
          overwriteFiles: [],
        }}
        onSelect={() => {}}
        onConfirm={() => {}}
        onCancel={() => (cancelled += 1)}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write('\x1b'); // Esc
    expect(cancelled).toBe(1);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// runTui 集成
// ---------------------------------------------------------------------------

describe('runTui /rewind 集成（T-102）', () => {
  test('/rewind 列出快照点并打开选择器', async () => {
    const homeDir = makeHome();
    const cwd = join(homeDir, 'proj');
    mkdirSync(cwd, { recursive: true });
    // 预置一个快照点（真实影子 git）
    const store = new SnapshotStore({ homeDir, cwd });
    writeFileSync(join(cwd, 'a.ts'), 'code\n', 'utf8');
    const point = await store.snapshot();
    expect(point?.id).not.toBeNull();
    const short = point?.id?.slice(0, 8) ?? '';

    const { stdout, stdin, exit } = await startTui({
      homeDir,
      cwd,
      provider: new StubProvider('stub'),
    });
    await typeAndEnter(stdin, '/rewind');
    const frame = stdout.lastFrame();
    expect(frame).toContain('快照点（/rewind）');
    expect(frame).toContain(short);

    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write('\x03'); // Ctrl+C 退出
    await flush();
    await exit;
  });

  test('无快照点时可 /rewind 但提示', async () => {
    const homeDir = makeHome();
    const cwd = join(homeDir, 'proj');
    mkdirSync(cwd, { recursive: true });
    const { stdout, stdin, exit } = await startTui({
      homeDir,
      cwd,
      provider: new StubProvider('stub'),
    });
    await typeAndEnter(stdin, '/rewind');
    expect(stdout.lastFrame()).toContain('没有可回滚的快照点');
    stdin.write('\x03');
    await flush();
    await exit;
  });

  test('确认还原后文件回到目标点，会话插入「已回滚」说明', async () => {
    const homeDir = makeHome();
    const cwd = join(homeDir, 'proj');
    mkdirSync(cwd, { recursive: true });
    // 预置两个快照点：P0（初始）→ P1（改 a.txt + 新建 c.txt）
    const store = new SnapshotStore({ homeDir, cwd });
    writeFileSync(join(cwd, 'a.txt'), 'v1\n', 'utf8');
    const p0 = (await store.snapshot())?.id as string;
    writeFileSync(join(cwd, 'a.txt'), 'v2\n', 'utf8');
    writeFileSync(join(cwd, 'c.txt'), 'new\n', 'utf8');
    const p1 = (await store.snapshot())?.id as string;
    expect(p0).not.toBeNull();
    expect(p1).not.toBeNull();

    const { stdout, stdin, exit } = await startTui({
      homeDir,
      cwd,
      provider: new StubProvider('stub'),
    });
    // /rewind → 数字键 2 选中 P0（列表新 → 旧，P0 在第 2 位）→ Enter 确认还原
    await typeAndEnter(stdin, '/rewind');
    await flush();
    stdin.write('2');
    await flush();
    stdin.write('\r');
    await flush();
    expect(stdout.lastFrame()).toContain('已还原');
    expect(stdout.lastFrame()).toContain('删除 1 个文件');

    // 文件已还原到 P0
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('v1\n');
    expect(
      (() => {
        try {
          return readFileSync(join(cwd, 'c.txt'), 'utf8');
        } catch {
          return null;
        }
      })(),
    ).toBeNull();

    // 会话日志插入了「用户已回滚」说明
    const sessionStore = new SessionStore({ homeDir });
    const sessions = await sessionStore.list(projectHash(cwd));
    expect(sessions.length).toBeGreaterThan(0);
    const read = await sessionStore.read(
      projectHash(cwd),
      sessions[0]?.sessionId as string,
    );
    const userTexts = (read?.records ?? [])
      .filter((record) => record.kind === 'user')
      .map((record) => (record.kind === 'user' ? record.data.text : ''));
    expect(userTexts.join('\n')).toContain('用户已回滚到快照点');
    expect(userTexts.join('\n')).toContain('请勿重复已撤销的工作');

    stdin.write('\x03');
    await flush();
    await exit;
  });

  test('/snapshots 查看占用；--cleanup 触发清理', async () => {
    const homeDir = makeHome();
    const cwd = join(homeDir, 'proj');
    mkdirSync(cwd, { recursive: true });
    const store = new SnapshotStore({ homeDir, cwd });
    writeFileSync(join(cwd, 'a.txt'), 'v1\n', 'utf8');
    await store.snapshot({ sessionId: 'sess-1' });

    const { stdout, stdin, exit } = await startTui({
      homeDir,
      cwd,
      provider: new StubProvider('stub'),
    });
    // /snapshots：占用报告（含当前项目哈希）
    await typeAndEnter(stdin, '/snapshots');
    expect(stdout.lastFrame()).toContain('快照占用');
    expect(stdout.lastFrame()).toContain(store.projectHash);
    expect(stdout.lastFrame()).toContain('当前项目');
    // /snapshots --cleanup：触发清理（无过期 → 移除 0）
    await typeAndEnter(stdin, '/snapshots --cleanup');
    expect(stdout.lastFrame()).toContain('快照清理完成');
    expect(stdout.lastFrame()).toContain('移除 0 条');

    stdin.write('\x03');
    await flush();
    await exit;
  });

  test('自动快照端到端：工具执行 → 轮末快照 → 日志 appendSnapshot → /rewind 可见', async () => {
    const homeDir = makeHome();
    const cwd = join(homeDir, 'proj');
    mkdirSync(cwd, { recursive: true });
    const sessionStore = new SessionStore({ homeDir });

    // stub：第一轮发出 write 工具调用（写 hello.txt），第二轮纯文本结束
    const provider = new RoundsStubProvider('stub', [
      [
        {
          type: 'tool_use',
          id: 'call-w1',
          name: 'write',
          input: { path: 'hello.txt', content: 'hi\n' },
        },
        { type: 'usage', usage: { inputTokens: 8, outputTokens: 3 } },
        { type: 'finish', reason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: '完成' },
        { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
        { type: 'finish', reason: 'stop' },
      ],
    ]);
    const permission: PermissionConfig = {
      sandbox: 'workspace-write',
      policy: 'never', // 工作区内放手干：write 工具不弹审批，自动执行
      projectRoot: cwd,
    };

    const { stdout, stdin, exit } = await startTui({
      homeDir,
      cwd,
      provider,
      tools: defaultWriteTools(),
      permission,
    });

    await typeAndEnter(stdin, '帮我写一个文件');

    // 轮末自动快照：等会话日志出现 snapshot 条目（appendSnapshot 已入日志）
    let sessionId = '';
    const read = await waitFor<SessionReadResult>(async () => {
      const sessions = await sessionStore.list(projectHash(cwd));
      if (sessions.length === 0) return null;
      sessionId = sessions[0]?.sessionId ?? '';
      const current = await sessionStore.read(projectHash(cwd), sessionId);
      if (
        current === null ||
        !current.records.some((record) => record.kind === 'snapshot')
      ) {
        return null;
      }
      return current;
    }, 10_000);

    // 工具确实执行了：文件已写入工作树
    expect(readFileSync(join(cwd, 'hello.txt'), 'utf8')).toBe('hi\n');

    // appendSnapshot 条目：ref = 快照点 id、summary 提到 hello.txt
    const snapshotEntries = read.records.filter(
      (record) => record.kind === 'snapshot',
    );
    expect(snapshotEntries.length).toBeGreaterThan(0);
    const snapshotEntry = snapshotEntries[snapshotEntries.length - 1];
    expect(snapshotEntry.kind).toBe('snapshot');
    expect(snapshotEntry.data.ref.length).toBe(40);
    expect(snapshotEntry.data.summary).toContain('hello.txt');

    // 快照清单：最新点与日志条目同 id、非降级、内容捕获 hello.txt
    const store = new SnapshotStore({ homeDir, cwd });
    const points = await store.listSnapshots();
    expect(points.length).toBeGreaterThan(0);
    const latest = points[0];
    expect(latest?.id).toBe(snapshotEntry.data.ref);
    expect(latest?.degraded).toBe(false);
    expect(latest?.summary).toContain('hello.txt');
    expect(latest?.sessionId).toBe(sessionId);

    // /rewind 列出该快照点（8 位短哈希可见）
    await typeAndEnter(stdin, '/rewind');
    const frame = stdout.lastFrame();
    expect(frame).toContain('快照点（/rewind）');
    expect(frame).toContain((latest?.id ?? '').slice(0, 8));

    stdin.write('\x03');
    await flush();
    await exit;
  });
});
