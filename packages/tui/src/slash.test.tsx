/**
 * T-082 斜杠命令框架离线测试。
 *
 * 覆盖：
 * - 分发器 dispatchSlash：六个内置命令路由到对应处理器，未实现命令走
 *   onUnimplemented（返回 false）；
 * - /help：renderHelpText 列出全部命令与用法（BUILTIN_SLASH_COMMANDS 数据源）；
 * - /model 候选：collectModelCandidates（当前模型 + 环境派生 + 缺省锚点，去重）；
 * - model_switch：日志条目追加（core SessionLog）与投影忽略（projectMessages），
 *   lastModelSwitchTo 取最后切换目标；
 * - 集成（驱动 runTui，注入假流 + stub provider）：/model 切换 provider 且
 *   上下文延续、/clear 清空上下文并保留原日志、/help 展示、未实现命令 notice；
 * - ModelPicker 组件：渲染候选 / ↑↓+Enter / 数字键 / Esc 取消。
 *
 * 全部离线：provider 用 stub（不访问外网），createProvider 注入 stub，
 * /model 不读真实环境变量；runTui 的 homeDir 用临时目录隔离。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import type {
  ModelMessage,
  ModelProvider,
  ProviderCapabilities,
  SessionRecord,
  StreamChatInput,
  StreamEvent,
  StructuredPlan,
} from '@modou/core';
import {
  projectHash,
  projectMessages,
  serializeStructuredPlan,
  SessionLog,
  SessionStore,
} from '@modou/core';
import type { TuiOptions } from './startup';
import { ModelPicker } from './model';
import {
  BUILTIN_SLASH_COMMANDS,
  collectModelCandidates,
  customToCommandInfo,
  dispatchSlash,
  lastModelSwitchTo,
  renderHelpText,
  type SlashHandlers,
} from './slash';
import { runTui } from './index';

// ---------------------------------------------------------------------------
// 测试替身：StubProvider —— 完全本地、不访问外网；记录每次请求的消息（断言
// 上下文延续用）
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

class RecordingProvider implements ModelProvider {
  readonly id = 'openai-compat';
  readonly capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES;
  /** 每次 streamChat 收到的 messages（断言上下文延续）。 */
  readonly messages: ModelMessage[][] = [];
  /** 每次 streamChat 收到的 tools（断言自定义命令工具白名单）。 */
  readonly seenTools: Array<Record<string, unknown> | undefined> = [];

  constructor(readonly modelId: string) {}

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    this.messages.push(input.messages);
    this.seenTools.push(input.tools);
    const text = `回复(${this.modelId})`;
    for (const char of text) {
      yield { type: 'text_delta', delta: char };
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: 'stop' };
  }
}

/**
 * 首轮回放结构化计划文本（Plan Mode 研究轮 → 产出计划），其后各轮回放普通文本
 * （批准后的执行轮）。驱动「/plan → 计划面板 → a 批准」的完整流程。
 */
class PlanThenTextProvider implements ModelProvider {
  readonly id = 'openai-compat';
  readonly capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES;
  readonly modelId = 'stub-model';
  private calls = 0;

  constructor(private readonly planText: string) {}

  async *streamChat(): AsyncIterable<StreamEvent> {
    const text = this.calls === 0 ? this.planText : '开始按计划执行';
    this.calls += 1;
    for (const char of text) {
      yield { type: 'text_delta', delta: char };
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: 'stop' };
  }
}

// ---------------------------------------------------------------------------
// 假流（复刻 ink-testing-library 的 Stdout / Stdin：EventEmitter 而非 Stream，
// 使 Ink 走「传入的 stdin」路径；write 即一次 input 事件）
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

/** 跑一个 runTui（假流 + 临时 homeDir + 独立 signalEmitter），返回可驱动的句柄。 */
async function startTui(options: TuiOptions): Promise<{
  stdout: FakeStdout;
  stdin: FakeStdin;
  homeDir: string;
  exit: Promise<{ exitCode: number }>;
}> {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const signalEmitter = new EventEmitter();
  const homeDir = mkdtempSync(join(tmpdir(), 'modou-tui-slash-'));
  const exit = runTui({
    homeDir,
    cwd: homeDir,
    // FakeStdout/FakeStdin 只实现 Ink 用到的表面（write/columns/rows/data），
    // 与 NodeJS 流接口无关——结构不相容，做类型收窄即可（运行时行为等价
    // ink-testing-library 的 Stdout/Stdin）。
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    signalEmitter,
    ...options,
  });
  await flush(); // 等 Ink 挂载 + useInput 订阅就绪
  return { stdout, stdin, homeDir, exit };
}

/** 等 React / Ink 渲染落地（事件流消费是异步的，多 flush 一次到位）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setTimeout(resolve, 40));
}

/** 模拟一次键盘输入：整段文本作为一次 input 事件，随后回车提交。 */
async function typeAndEnter(stdin: FakeStdin, text: string): Promise<void> {
  stdin.write(text);
  await flush();
  stdin.write('\r');
  await flush();
}

/** 假流的 Ctrl+C：App 的 useInput 捕获 → onExit → runTui 干净退出。 */
async function quit(
  stdin: FakeStdin,
  exit: Promise<{ exitCode: number }>,
): Promise<void> {
  stdin.write('\x03');
  await flush();
  await exit;
}

/** 当前项目 sessions 目录里的全部 jsonl 文件。 */
function sessionFiles(homeDir: string): string[] {
  const dir = join(homeDir, '.modou', 'sessions', projectHash(homeDir));
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
}

/** 读全部会话文件的行（按文件名排序，合并断言用）。 */
function readAllSessionLines(homeDir: string): string[] {
  const dir = join(homeDir, '.modou', 'sessions', projectHash(homeDir));
  const lines: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) continue;
    lines.push(...readFileSync(join(dir, name), 'utf8').trim().split('\n'));
  }
  return lines.filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// 分发器 / /help / 候选 / model_switch（纯函数）
// ---------------------------------------------------------------------------

describe('dispatchSlash（T-082 分发器）', () => {
  test('八个内置命令路由到对应处理器，未实现命令走 onUnimplemented', () => {
    const called: string[] = [];
    const handlers: SlashHandlers = {
      help: () => called.push('help'),
      model: (args) => called.push(`model:${args ?? ''}`),
      compact: () => called.push('compact'),
      resume: (args) => called.push(`resume:${args ?? ''}`),
      context: (args) => called.push(`context:${args ?? ''}`),
      clear: () => called.push('clear'),
      rewind: () => called.push('rewind'),
      snapshots: (args) => called.push(`snapshots:${args ?? ''}`),
      plan: (args) => called.push(`plan:${args ?? ''}`),
    };
    const unimplemented: Array<[string, string | undefined]> = [];
    const onUnimplemented = (name: string, args?: string): void => {
      unimplemented.push([name, args]);
    };

    expect(dispatchSlash('help', undefined, handlers, onUnimplemented)).toBe(
      true,
    );
    expect(dispatchSlash('model', 'gpt-4o', handlers, onUnimplemented)).toBe(
      true,
    );
    expect(dispatchSlash('model', undefined, handlers, onUnimplemented)).toBe(
      true,
    );
    expect(dispatchSlash('compact', undefined, handlers, onUnimplemented)).toBe(
      true,
    );
    expect(dispatchSlash('resume', 'sess-1', handlers, onUnimplemented)).toBe(
      true,
    );
    expect(dispatchSlash('context', '--json', handlers, onUnimplemented)).toBe(
      true,
    );
    expect(dispatchSlash('clear', undefined, handlers, onUnimplemented)).toBe(
      true,
    );
    expect(dispatchSlash('rewind', undefined, handlers, onUnimplemented)).toBe(
      true,
    );
    expect(
      dispatchSlash('snapshots', '--cleanup', handlers, onUnimplemented),
    ).toBe(true);
    expect(dispatchSlash('plan', '重构', handlers, onUnimplemented)).toBe(true);
    // 未实现命令：返回 false、处理器不触发、onUnimplemented 收到原名与参数
    expect(dispatchSlash('foobar', 'x', handlers, onUnimplemented)).toBe(false);

    expect(called).toEqual([
      'help',
      'model:gpt-4o',
      'model:',
      'compact',
      'resume:sess-1',
      'context:--json',
      'clear',
      'rewind',
      'snapshots:--cleanup',
      'plan:重构',
    ]);
    expect(unimplemented).toEqual([['foobar', 'x']]);
  });
});

describe('/help（T-082）', () => {
  test('BUILTIN_SLASH_COMMANDS 包含内置命令与 0.11.0 /plan', () => {
    expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      'help',
      'model',
      'compact',
      'resume',
      'context',
      'clear',
      'rewind',
      'snapshots',
      'plan',
    ]);
  });

  test('renderHelpText 列出每条命令的用法与描述', () => {
    const text = renderHelpText();
    expect(text).toContain('斜杠命令：');
    for (const command of BUILTIN_SLASH_COMMANDS) {
      expect(text).toContain(command.usage);
      expect(text).toContain(command.description);
    }
  });
});

describe('collectModelCandidates（/model 候选列表）', () => {
  test('当前模型 → 环境派生模型 → 缺省锚点，去重保序', () => {
    const provider = new RecordingProvider('current-model');
    const env = {
      MODOU_MODEL: 'env-model',
      MODOU_TEST_MODEL_DEEPSEEK: 'deepseek',
      OPENAI_MODEL: 'current-model', // 与当前模型重复 → 去重
    } as NodeJS.ProcessEnv;
    expect(collectModelCandidates(provider, env)).toEqual([
      'current-model',
      'env-model',
      'deepseek',
      'gpt-4o',
      'claude-sonnet-4-5',
    ]);
  });

  test('空环境回落缺省锚点（列表恒非空）', () => {
    const provider = new RecordingProvider('only-me');
    expect(collectModelCandidates(provider, {})).toEqual([
      'only-me',
      'gpt-4o',
      'claude-sonnet-4-5',
    ]);
  });
});

describe('model_switch（core 日志条目 / 投影 / 恢复解析）', () => {
  test('appendModelSwitch 入日志，projectMessages 忽略该条目（上下文延续）', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'modou-slash-core-'));
    try {
      const session = new SessionLog({ homeDir, cwd: homeDir });
      await session.appendModelSwitch('stub-a', 'stub-b');
      await session.appendUser('你好');
      const store = new SessionStore({ homeDir });
      const read = await store.read(projectHash(homeDir), session.sessionId);
      expect(read).not.toBeNull();
      const switches = (read?.records ?? []).filter(
        (record) => record.kind === 'model_switch',
      );
      expect(switches).toHaveLength(1);
      expect(switches[0]?.data).toEqual({ from: 'stub-a', to: 'stub-b' });
      // 投影只产生 user 消息：model_switch 是会话史条目，不进入模型消息序列
      expect(projectMessages(read?.records ?? [])).toEqual([
        { role: 'user', content: '你好' },
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('lastModelSwitchTo 取最后一条 model_switch 的目标模型', () => {
    const records: SessionRecord[] = [
      { seq: 1, ts: 1, kind: 'model_switch', data: { from: 'a', to: 'b' } },
      { seq: 2, ts: 2, kind: 'user', data: { text: 'hi' } },
      { seq: 3, ts: 3, kind: 'model_switch', data: { from: 'b', to: 'c' } },
    ];
    expect(lastModelSwitchTo(records)).toBe('c');
    expect(
      lastModelSwitchTo([
        { seq: 1, ts: 1, kind: 'user', data: { text: 'hi' } },
      ]),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 集成：驱动 runTui（注入假流 + stub provider）
// ---------------------------------------------------------------------------

describe('runTui 斜杠命令集成（T-082）', () => {
  afterAll(() => {
    cleanup();
  });

  test('/model 切换 provider 且上下文延续，切换入日志', async () => {
    const initialProvider = new RecordingProvider('stub-a');
    const createdProviders: RecordingProvider[] = [];
    // createProvider stub：离线重建（不读真实环境变量）；保留实例以便断言
    const createProvider = (config: { model?: string }): ModelProvider => {
      const provider = new RecordingProvider(config.model ?? 'stub-b');
      createdProviders.push(provider);
      return provider;
    };
    const { stdout, stdin, homeDir, exit } = await startTui({
      provider: initialProvider,
      createProvider,
    });

    // 第一轮：提交消息，断言 stub 收到单条消息
    await typeAndEnter(stdin, '第一条消息');
    expect(initialProvider.messages).toHaveLength(1);
    expect(initialProvider.messages[0]).toEqual([
      { role: 'user', content: '第一条消息' },
    ]);

    // /model stub-b：重建 provider（createProvider 被调）、状态栏模型名变更
    await typeAndEnter(stdin, '/model stub-b');
    expect(createdProviders).toHaveLength(1);
    expect(createdProviders[0]?.modelId).toBe('stub-b');
    expect(stdout.lastFrame()).toContain('stub-b');

    // 第二轮：新 provider 收到完整历史（上下文延续，002 8.2 消息不丢）
    await typeAndEnter(stdin, '第二条消息');
    expect(createdProviders[0]?.messages).toHaveLength(1);
    const secondTurn = createdProviders[0]?.messages[0] ?? [];
    expect(secondTurn).toHaveLength(3); // user第一条 + assistant回复 + user第二条
    expect(secondTurn[0]).toEqual({ role: 'user', content: '第一条消息' });
    expect(secondTurn[2]).toEqual({ role: 'user', content: '第二条消息' });

    // 会话日志：model_switch 条目入日志（/resume 重建依据）
    const lines = readAllSessionLines(homeDir);
    const switches = lines
      .map((line) => JSON.parse(line) as SessionRecord)
      .filter((record) => record.kind === 'model_switch');
    expect(switches).toHaveLength(1);
    expect(switches[0]?.data).toEqual({ from: 'stub-a', to: 'stub-b' });

    await quit(stdin, exit);
  });

  test('/clear 清空上下文并开启新会话，原日志保留', async () => {
    const provider = new RecordingProvider('stub-a');
    const { stdin, homeDir, exit } = await startTui({
      provider,
      createProvider: (config) =>
        new RecordingProvider(config.model ?? 'stub-a'),
    });

    await typeAndEnter(stdin, '消息一');
    await typeAndEnter(stdin, '消息二');
    // 两轮之后：provider 记录两次请求，第二次含「消息一 + 其回复 + 消息二」
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages[1]).toHaveLength(3);

    // /clear：开启新会话（notice 告知）
    await typeAndEnter(stdin, '/clear');
    // 新轮次：provider 只收到单条新消息（历史已清空）
    await typeAndEnter(stdin, '消息三');
    expect(provider.messages).toHaveLength(3);
    expect(provider.messages[2]).toEqual([{ role: 'user', content: '消息三' }]);

    // 原日志保留：sessions 目录下应有两个会话文件（原 + 新），原日志仍含「消息一」
    const files = sessionFiles(homeDir);
    expect(files).toHaveLength(2);
    expect(readAllSessionLines(homeDir).join('\n')).toContain('消息一');

    await quit(stdin, exit);
  });

  test('/help 展示全部命令与用法', async () => {
    const { stdout, stdin, exit } = await startTui({
      provider: new RecordingProvider('stub-a'),
    });
    await typeAndEnter(stdin, '/help');
    const frame = stdout.lastFrame();
    expect(frame).toContain('斜杠命令：');
    for (const command of BUILTIN_SLASH_COMMANDS) {
      expect(frame).toContain(command.usage);
    }
    await quit(stdin, exit);
  });

  test('未实现命令发「尚未实现」notice，并列出已支持命令', async () => {
    const { stdout, stdin, exit } = await startTui({
      provider: new RecordingProvider('stub-a'),
    });
    await typeAndEnter(stdin, '/foobar');
    const frame = stdout.lastFrame();
    expect(frame).toContain('/foobar 尚未实现');
    expect(frame).toContain('/help');
    expect(frame).toContain('/model');
    await quit(stdin, exit);
  });
});

// ---------------------------------------------------------------------------
// ModelPicker 组件（T-082 /model 选择器）
// ---------------------------------------------------------------------------

describe('ModelPicker（T-082 /model 模型选择器）', () => {
  afterAll(() => {
    cleanup();
  });

  test('渲染候选列表并标注当前模型', async () => {
    const { lastFrame, unmount } = render(
      <ModelPicker
        candidates={['stub-a', 'stub-b', 'gpt-4o']}
        currentModel="stub-a"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('切换模型（/model）');
    expect(frame).toContain('stub-a');
    expect(frame).toContain('stub-b');
    expect(frame).toContain('← 当前');
    unmount();
  });

  test('Enter 选择当前选中项（首项默认选中）', async () => {
    const selected: string[] = [];
    const { stdin, unmount } = render(
      <ModelPicker
        candidates={['stub-a', 'stub-b']}
        currentModel="stub-a"
        onSelect={(modelId) => selected.push(modelId)}
        onCancel={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write('\r');
    expect(selected).toEqual(['stub-a']);
    unmount();
  });

  test('↑/↓ 循环移动选中项，Enter 选择移动后的项', async () => {
    const selected: string[] = [];
    const { stdin, unmount } = render(
      <ModelPicker
        candidates={['stub-a', 'stub-b', 'stub-c']}
        currentModel="stub-a"
        onSelect={(modelId) => selected.push(modelId)}
        onCancel={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    stdin.write('\x1b[B'); // ↓（0 → 1）
    stdin.write('\x1b[B'); // ↓（1 → 2）
    stdin.write('\r');
    expect(selected).toEqual(['stub-c']);

    stdin.write('\x1b[A'); // ↑（2 → 1）
    stdin.write('\r');
    expect(selected).toEqual(['stub-c', 'stub-b']);
    unmount();
  });

  test('数字键直接选择对应候选（1-based）', async () => {
    const selected: string[] = [];
    const { stdin, unmount } = render(
      <ModelPicker
        candidates={['stub-a', 'stub-b']}
        currentModel="stub-a"
        onSelect={(modelId) => selected.push(modelId)}
        onCancel={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    stdin.write('2');
    expect(selected).toEqual(['stub-b']);
    unmount();
  });

  test('Esc 取消（onCancel）', async () => {
    let cancelled = 0;
    const { stdin, unmount } = render(
      <ModelPicker
        candidates={['stub-a']}
        currentModel="stub-a"
        onSelect={() => {}}
        onCancel={() => (cancelled += 1)}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    stdin.write('\x1b');
    expect(cancelled).toBe(1);
    unmount();
  });
});

describe('自定义斜杠命令分发（T-114）', () => {
  test('未命中内置但命中自定义命令表：调 handlers.custom，返回 true', () => {
    const custom = {
      name: 'fix-lint',
      description: '修复 lint 错误',
      allowedTools: ['read', 'grep', 'glob', 'write', 'edit', 'bash'],
      prompt: '请修复 lint：$1',
    };
    const called: string[] = [];
    const handlers: SlashHandlers = {
      help: () => called.push('help'),
      model: () => called.push('model'),
      compact: () => called.push('compact'),
      resume: () => called.push('resume'),
      context: () => called.push('context'),
      clear: () => called.push('clear'),
      rewind: () => called.push('rewind'),
      snapshots: () => called.push('snapshots'),
      plan: () => called.push('plan'),
      custom: (command, args) =>
        called.push(`custom:${command.name}:${args ?? ''}`),
    };
    expect(
      dispatchSlash('fix-lint', 'src/a.ts', handlers, () => {}, [custom]),
    ).toBe(true);
    expect(dispatchSlash('nope', undefined, handlers, () => {}, [custom])).toBe(
      false,
    );
    expect(called).toEqual(['custom:fix-lint:src/a.ts']);
  });

  test('customToCommandInfo：转 /help 可展示的命令信息', () => {
    const info = customToCommandInfo({
      name: 'deploy',
      description: '部署到测试环境',
      prompt: '部署',
    });
    expect(info.usage).toBe('/deploy [参数…]');
    expect(info.description).toBe('部署到测试环境');
  });

  test('renderHelpText 附加自定义命令', () => {
    const text = renderHelpText([
      { name: 'deploy', usage: '/deploy [参数…]', description: '部署' },
    ]);
    expect(text).toContain('/deploy [参数…]');
    expect(text).toContain('部署');
  });
});

describe('自定义斜杠命令集成（T-114 runTui 接线）', () => {
  test('.modou/commands/*.md 注册的命令：占位展开 + 工具白名单 + /help 展示', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'modou-tui-custom-'));
    try {
      const commandsDir = join(dir, '.modou', 'commands');
      mkdirSync(commandsDir, { recursive: true });
      writeFileSync(
        join(commandsDir, 'greet.md'),
        `---
name: greet
description: 只读打招呼
allowedTools: read
---
你好，$1！请只读研究，不要改文件。`,
        'utf8',
      );
      const provider = new RecordingProvider('stub-model');
      const { stdin, exit } = await startTui({ provider, cwd: dir });

      // 提交 /greet 世界：占位 $1 → 世界，工具白名单只有 read
      await typeAndEnter(stdin, '/greet 世界');
      expect(provider.messages).toHaveLength(1);
      const content = provider.messages[0]?.[0]?.content;
      expect(typeof content).toBe('string');
      expect(content as string).toContain('你好，世界！');
      // 工具白名单：模型只看到 read（allowedTools 收窄）
      const tools = provider.seenTools[0];
      expect(tools !== undefined && Object.keys(tools)).toEqual(['read']);

      await quit(stdin, exit);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('计划批准落盘失败（T-113 告警不静默）', () => {
  test('.modou/plans 不可写时批准计划：发「计划落盘失败」warn notice，计划仍执行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'modou-tui-planfail-'));
    try {
      // .modou/plans 是普通文件 → savePlanToFile 的 mkdir 抛 EEXIST/ENOTDIR
      const modouDir = join(dir, '.modou');
      mkdirSync(modouDir, { recursive: true });
      writeFileSync(join(modouDir, 'plans'), '不是目录', 'utf8');

      const plan: StructuredPlan = {
        goal: '重构订单模块',
        files: ['src/orders.ts'],
        steps: ['读取现状', '抽取共享函数'],
        verification: ['bun test'],
        risks: ['保持对外行为不变'],
      };
      const provider = new PlanThenTextProvider(serializeStructuredPlan(plan));
      const { stdin, stdout, exit } = await startTui({ provider, cwd: dir });

      // /plan 进入计划模式 → 模型产出结构化计划 → 计划面板等待评审
      await typeAndEnter(stdin, '/plan 重构');
      await flush();
      await flush();
      // 批准 → savePlanToFile 失败 → warn notice（不静默）；计划仍回填执行
      stdin.write('a');
      await flush();
      await flush();

      const allFrames = stdout.frames.join('\n');
      expect(allFrames).toContain('计划落盘失败');
      expect(allFrames).toContain('计划仍将执行');

      await quit(stdin, exit);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
