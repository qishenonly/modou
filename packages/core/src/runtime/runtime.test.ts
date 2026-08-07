import { describe, expect, test } from 'bun:test';
import type { ModelMessage, ToolSet } from 'ai';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProviderCapabilities } from '../provider/capabilities';
import { ProviderError } from '../provider/errors';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
  TokenUsage,
} from '../provider/types';
import {
  defaultReadonlyTools,
  defaultWriteTools,
  globTool,
  grepTool,
  readTool,
} from '../tools';
import { ToolRegistry } from '../tools/registry';
import type { Tool, ToolContext } from '../tools/types';
import { runAgentTurn } from './loop';
import type { RuntimeEvent } from './loop';

// ---------------------------------------------------------------------------
// 测试替身：StubProvider —— 一个完全本地、不访问外网的假 ModelProvider。
// 按调用顺序消费 rounds；用尽后重放最后一轮。可配置「第 N 个事件后暂停」
// （中断测试用）与「抛错轮」。
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

type StubRound = StreamEvent[] | { readonly throw: unknown };

class StubProvider implements ModelProvider {
  readonly id = 'stub';
  readonly modelId = 'stub-model';
  readonly capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES;
  /** 每次 streamChat 收到的消息序列（验证「未知工具」回喂用） */
  readonly seenMessages: ModelMessage[][] = [];
  /** 每次 streamChat 收到的 tools（验证「工具定义已传给模型」用） */
  readonly seenTools: Array<ToolSet | undefined> = [];
  private callCount = 0;
  private released = false;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly rounds: StubRound[],
    /** 产出第 N 个事件后暂停，等待 release() 或被 abort 打断 */
    private readonly pauseAfterEvent?: number,
  ) {}

  release(): void {
    this.released = true;
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    this.seenMessages.push(input.messages);
    this.seenTools.push(input.tools);
    const round = this.rounds[Math.min(this.callCount, this.rounds.length - 1)];
    this.callCount += 1;

    if ('throw' in round) throw round.throw;

    let index = 0;
    for (const event of round) {
      if (input.abortSignal?.aborted) {
        throw new ProviderError({ kind: 'aborted', message: '请求已被中断' });
      }
      yield event;
      index += 1;
      if (
        this.pauseAfterEvent !== undefined &&
        index === this.pauseAfterEvent
      ) {
        await this.hold(input.abortSignal);
      }
    }
  }

  /** 挂起直到 release() 或 abort；模拟真实 provider 的中断行为。 */
  private hold(signal: AbortSignal | undefined): Promise<void> {
    if (this.released) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        signal?.removeEventListener('abort', onAbort);
        reject(new ProviderError({ kind: 'aborted', message: '请求已被中断' }));
      };
      if (signal === undefined) {
        this.waiters.push(resolve);
        return;
      }
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }
}

// ---------------------------------------------------------------------------
// 事件序列构造
// ---------------------------------------------------------------------------

const userMsg: ModelMessage = { role: 'user', content: '你好' };

function textEvents(
  text: string,
  usageOverrides: Partial<TokenUsage> = {},
): StreamEvent[] {
  const events: StreamEvent[] = Array.from(text).map((char) => ({
    type: 'text_delta',
    delta: char,
  }));
  events.push({
    type: 'usage',
    usage: { inputTokens: 10, outputTokens: 5, ...usageOverrides },
  });
  events.push({ type: 'finish', reason: 'stop' });
  return events;
}

function toolUseEvents(
  name = 'bash',
  id = 'call-1',
  input: unknown = { cmd: 'ls' },
): StreamEvent[] {
  return [
    { type: 'tool_use', id, name, input },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: 'tool_use' },
  ];
}

/** 测试用 stub 工具：回显入参（供「已注册工具执行」用例）。 */
const echoTool: Tool = {
  name: 'echo',
  description: '原样返回输入的文本（测试用）',
  risk: 'read',
  schema: z.object({ text: z.string().min(1) }),
  execute: async (args: { text: string }) => ({
    ok: true,
    forModel: `echo:${args.text}`,
  }),
};

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('runAgentTurn（0.1.0 裸循环）', () => {
  test('正常文本流：end_turn 收尾，事件与用量完整', async () => {
    const stub = new StubProvider([textEvents('你好')]);
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      { provider: stub, messages: [userMsg], options: { maxTurns: 5 } },
      (event) => events.push(event),
    );

    expect(result.termination).toBe('end_turn');
    expect(result.state).toBe('idle');
    expect(result.turns).toBe(1);
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('你好');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(stub.seenMessages).toHaveLength(1);
    expect(stub.seenMessages[0]).toEqual([userMsg]);

    expect(events).toContainEqual({ type: 'turn_start', turn: 1 });
    expect(events).toContainEqual({ type: 'text_delta', delta: '你' });
    expect(events).toContainEqual({ type: 'text_delta', delta: '好' });
    expect(events).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(events).toContainEqual({
      type: 'turn_end',
      turn: 1,
      termination: 'end_turn',
    });
  });

  test('tool_use → 「未知工具」回喂 → 模型改出纯文本（2 轮）', async () => {
    const stub = new StubProvider([
      toolUseEvents('bash', 'call-1'),
      textEvents('好的，不再使用工具。'),
    ]);
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      { provider: stub, messages: [userMsg], options: { maxTurns: 5 } },
      (event) => events.push(event),
    );

    expect(result.termination).toBe('end_turn');
    expect(result.state).toBe('idle');
    expect(result.turns).toBe(2);
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('好的，不再使用工具。');
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 8 });
    expect(stub.seenMessages).toHaveLength(2);

    // 第二轮请求里带着 assistant tool-call + tool 错误结果
    const second = stub.seenMessages[1];
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'bash',
          input: { cmd: 'ls' },
        },
      ],
    });
    expect(second[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'bash',
          output: {
            type: 'error-text',
            value: expect.stringContaining('未知工具 "bash"'),
          },
        },
      ],
    });

    expect(events).toContainEqual({
      type: 'tool_use',
      id: 'call-1',
      name: 'bash',
      input: { cmd: 'ls' },
    });
    expect(events).toContainEqual({
      type: 'tool_feedback',
      id: 'call-1',
      name: 'bash',
      error: expect.stringContaining('未知工具 "bash"'),
    });
  });

  test('注册工具：tool_use → 管线执行 → 结果回喂 → 第二轮模型看到结果', async () => {
    const registry = new ToolRegistry().register(echoTool);
    const stub = new StubProvider([
      toolUseEvents('echo', 'call-1', { text: '你好' }),
      textEvents('已收到回显。'),
    ]);
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        tools: registry,
        options: { maxTurns: 5 },
      },
      (event) => events.push(event),
    );

    expect(result.termination).toBe('end_turn');
    expect(result.state).toBe('idle');
    expect(result.turns).toBe(2);
    expect(result.text).toBe('已收到回显。');
    expect(stub.seenMessages).toHaveLength(2);

    // 第二轮请求带着 assistant tool-call + tool 成功结果（AI SDK 规范格式）
    const second = stub.seenMessages[1];
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'echo',
          input: { text: '你好' },
        },
      ],
    });
    expect(second[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'echo',
          output: { type: 'text', value: 'echo:你好' },
        },
      ],
    });

    // 事件流：流式 tool_use + 管线 tool_result（成功），不产生未知工具 notice
    expect(events).toContainEqual({
      type: 'tool_use',
      id: 'call-1',
      name: 'echo',
      input: { text: '你好' },
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      id: 'call-1',
      ok: true,
      summary: 'echo:你好',
      forModel: 'echo:你好',
    });
    expect(events.some((e) => e.type === 'tool_feedback')).toBe(false);
  });

  test('提供注册表但工具未注册：统一走管线产出 ok:false，列出可用工具', async () => {
    const registry = new ToolRegistry().register(echoTool); // 只有 echo
    const stub = new StubProvider([
      toolUseEvents('bash', 'call-1', { cmd: 'ls' }),
      textEvents('好的，不再调用。'),
    ]);
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        tools: registry,
        options: { maxTurns: 5 },
      },
      (event) => events.push(event),
    );

    expect(result.termination).toBe('end_turn');
    expect(result.turns).toBe(2);

    // 未注册工具统一走管线：管线产出 ok:false 且列出可用工具名（比 loop 弱诊断更可诊断）
    const second = stub.seenMessages[1];
    expect(second[2].role).toBe('tool');
    if (second[2].role !== 'tool') throw new Error('第二轮应带 tool 消息');
    const bashOutput = second[2].content[0];
    expect(bashOutput.type).toBe('tool-result');
    if (bashOutput.type !== 'tool-result')
      throw new Error('未注册工具应产出 tool-result');
    const value =
      'value' in bashOutput.output
        ? String(bashOutput.output.value)
        : '<无文本>';
    expect(value).toContain('未知工具 "bash"');
    expect(value).toContain('可用工具');
    expect(value).toContain('"echo"');

    // 管线 tool_result（ok:false）事件；不再走 loop 的 tool_feedback 弱诊断
    expect(events).toContainEqual({
      type: 'tool_result',
      id: 'call-1',
      ok: false,
      summary: expect.stringContaining('未知工具'),
      forModel: expect.stringContaining('可用工具'),
    });
    expect(events.some((e) => e.type === 'tool_feedback')).toBe(false);
  });

  test('提供注册表时 streamChat 收到 tools（read/grep/glob，description 与 inputSchema 正确）', async () => {
    const registry = defaultReadonlyTools();
    const stub = new StubProvider([textEvents('好的')]);
    await runAgentTurn({
      provider: stub,
      messages: [userMsg],
      tools: registry,
      options: { maxTurns: 5 },
    });

    // streamChat 收到 ToolSet：三个只读工具全部声明给模型
    expect(stub.seenTools).toHaveLength(1);
    const toolSet = stub.seenTools[0];
    expect(toolSet).toBeDefined();
    if (toolSet === undefined)
      throw new Error('提供注册表时应把 tools 传给 provider');
    expect(Object.keys(toolSet).sort()).toEqual(['glob', 'grep', 'read']);

    // description 与注册表一致（模型看到的就是工具定义，单一来源）
    expect(toolSet.read?.description).toBe(readTool.description);
    expect(toolSet.grep?.description).toBe(grepTool.description);
    expect(toolSet.glob?.description).toBe(globTool.description);

    // inputSchema 是 jsonSchema() 包装的 JSON Schema（.jsonSchema 取原始 schema）
    for (const name of ['read', 'grep', 'glob'] as const) {
      const inputSchema = toolSet[name]?.inputSchema;
      expect(inputSchema).toBeDefined();
      const raw = (inputSchema as { jsonSchema?: unknown } | undefined)
        ?.jsonSchema as { type?: unknown } | undefined;
      expect(raw?.type).toBe('object');
    }
    expect(stub.seenMessages).toHaveLength(1);
  });

  test('未提供注册表时 streamChat 不传 tools', async () => {
    const stub = new StubProvider([textEvents('好的')]);
    await runAgentTurn({
      provider: stub,
      messages: [userMsg],
      options: { maxTurns: 5 },
    });
    expect(stub.seenTools).toEqual([undefined]);
  });

  test('tool_use 入参含密钥：协议转发的 tool_use 事件里被脱敏', async () => {
    const stub = new StubProvider([
      toolUseEvents('bash', 'call-1', {
        token: 'sk-abcdefghijklmnopqrstuvwxyz',
      }),
      textEvents('明白。'),
    ]);
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      { provider: stub, messages: [userMsg], options: { maxTurns: 5 } },
      (event) => events.push(event),
    );

    expect(result.termination).toBe('end_turn');
    expect(result.turns).toBe(2);

    // 事件流里的 tool_use（bridge 据此映射协议 tool_call）入参已脱敏；
    // 线程里的 assistant tool-call 保留原始入参（回喂模型用，非事件流）。
    const toolUse = events.find((e) => e.type === 'tool_use');
    expect(toolUse).toBeDefined();
    if (toolUse?.type === 'tool_use') {
      expect(toolUse.input).toEqual({ token: 'sk-[REDACTED]' });
    }
    expect(JSON.stringify(events)).not.toContain(
      'sk-abcdefghijklmnopqrstuvwxyz',
    );
  });

  test('注册工具执行失败（错误即数据）：ok=false 结果回喂为 error-text', async () => {
    const failingTool: Tool = {
      name: 'fail',
      description: '总是失败的工具',
      risk: 'read',
      schema: z.object({}),
      execute: async () => ({
        ok: false,
        forModel: '参数错误：文件不存在（ENOENT）',
      }),
    };
    const registry = new ToolRegistry().register(failingTool);
    const stub = new StubProvider([
      toolUseEvents('fail', 'call-1', {}),
      textEvents('明白。'),
    ]);
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        tools: registry,
        options: { maxTurns: 5 },
      },
      (event) => events.push(event),
    );

    expect(result.termination).toBe('end_turn');
    expect(result.turns).toBe(2);

    const second = stub.seenMessages[1];
    expect(second[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'fail',
          output: {
            type: 'error-text',
            value: '参数错误：文件不存在（ENOENT）',
          },
        },
      ],
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      id: 'call-1',
      ok: false,
      summary: '参数错误：文件不存在（ENOENT）',
      forModel: '参数错误：文件不存在（ENOENT）',
    });
  });

  test('max_turns 超限：模型持续要求工具，轮次耗尽 → halted', async () => {
    const stub = new StubProvider([toolUseEvents(), textEvents('迟到的一轮')]);
    const result = await runAgentTurn({
      provider: stub,
      messages: [userMsg],
      options: { maxTurns: 1 },
    });

    expect(result.termination).toBe('halted');
    expect(result.state).toBe('halted');
    expect(result.turns).toBe(1);
    expect(result.finishReason).toBe('tool_use');
    expect(result.text).toBe('');
    // 第二轮因超限未发起：回喂只发生在本地线程，未触发新的模型请求
    expect(stub.seenMessages).toHaveLength(1);
  });

  test('maxTokens 超限：累计 usage 超过预算 → halted（已产出文本保留）', async () => {
    const stub = new StubProvider([
      textEvents('超预算的回答', { inputTokens: 40, outputTokens: 20 }),
    ]);
    const result = await runAgentTurn({
      provider: stub,
      messages: [userMsg],
      options: { maxTurns: 5, maxTokens: 50 },
    });

    expect(result.termination).toBe('halted');
    expect(result.state).toBe('halted');
    expect(result.turns).toBe(1);
    expect(result.text).toBe('超预算的回答');
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 20 });
  });

  test('abort 中途中断 → interrupted，保留已产文本与中断原因', async () => {
    const stub = new StubProvider([textEvents('部分回答')], 2);
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    let onSecondDelta: () => void = () => {};
    const secondDelta = new Promise<void>((resolve) => {
      onSecondDelta = resolve;
    });

    const pending = runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        options: { maxTurns: 5, abortSignal: controller.signal },
      },
      (event) => {
        events.push(event);
        const deltas = events.filter((e) => e.type === 'text_delta').length;
        if (deltas === 2) onSecondDelta();
      },
    );

    await secondDelta;
    const reason = new Error('用户打断');
    controller.abort(reason);
    const result = await pending;

    expect(result.termination).toBe('interrupted');
    expect(result.state).toBe('interrupted');
    expect(result.turns).toBe(1);
    expect(result.finishReason).toBeNull();
    expect(result.text).toBe('部分');
    expect(result.interruptedReason).toBe(reason);
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', delta: '部' },
      { type: 'text_delta', delta: '分' },
    ]);
  });

  test('provider 抛错 → error 终止，归一错误保留（非 retryable 不重试）', async () => {
    // 用不可重试的 not_found 验证「错误原样上抛、对象身份保留」；
    // 可重试错误（429/5xx）的退避重试行为由 retry.test.ts 覆盖。
    const notFound = new ProviderError({
      kind: 'not_found',
      message: '模型不存在',
    });
    const stub = new StubProvider([{ throw: notFound }]);
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      { provider: stub, messages: [userMsg], options: { maxTurns: 5 } },
      (event) => events.push(event),
    );

    expect(result.termination).toBe('error');
    expect(result.state).toBe('halted');
    expect(result.turns).toBe(1);
    expect(result.error).toBe(notFound);
    expect(result.text).toBe('');
    expect(events).toContainEqual({ type: 'error', error: notFound });
  });

  test('provider 抛非归一错误 → 归一为 ProviderError(unknown)', async () => {
    const stub = new StubProvider([{ throw: new Error('boom') }]);
    const result = await runAgentTurn({
      provider: stub,
      messages: [userMsg],
      options: { maxTurns: 5 },
    });

    expect(result.termination).toBe('error');
    expect(result.state).toBe('halted');
    expect(result.error?.kind).toBe('unknown');
    expect(result.error?.message).toBe('boom');
  });

  test('finish reason = error 的流 → error 终止', async () => {
    const stub = new StubProvider([
      [
        { type: 'text_delta', delta: '被截断' },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
        { type: 'finish', reason: 'error' },
      ],
    ]);
    const result = await runAgentTurn({
      provider: stub,
      messages: [userMsg],
      options: { maxTurns: 5 },
    });

    expect(result.termination).toBe('error');
    expect(result.state).toBe('halted');
    expect(result.text).toBe('被截断');
    expect(result.finishReason).toBe('error');
  });

  test('maxTurns=0：不发起任何请求，直接 halted', async () => {
    const stub = new StubProvider([textEvents('不该出现')]);
    const result = await runAgentTurn({
      provider: stub,
      messages: [userMsg],
      options: { maxTurns: 0 },
    });

    expect(result.termination).toBe('halted');
    expect(result.state).toBe('halted');
    expect(result.turns).toBe(0);
    expect(stub.seenMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// G-0.2.0 雏形：模型「先 Glob 定位 → 再 Read 读取」的工具调用链（离线端到端）。
// fixture 小仓库写在临时目录；用真实只读工具集（defaultReadonlyTools，含
// read/grep/glob，rg 走捆绑 @vscode/ripgrep）驱动 loop 依次执行工具。
// ---------------------------------------------------------------------------

describe('G-0.2.0 雏形：glob → read 工具调用链（离线端到端）', () => {
  test('模型先 glob 定位再 read 读取，loop 内工具依次执行且结果回喂', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'modou-g020-'));
    try {
      mkdirSync(join(fixture, 'src'), { recursive: true });
      writeFileSync(
        join(fixture, 'src', 'auth.ts'),
        'export function authenticate(token: string): boolean {\n' +
          '  return token.length > 0;\n' +
          '}\n',
        'utf8',
      );
      writeFileSync(join(fixture, 'README.md'), '# demo fixture\n', 'utf8');

      const tools = defaultReadonlyTools();
      const stub = new StubProvider([
        [
          {
            type: 'tool_use',
            id: 'g1',
            name: 'glob',
            input: { pattern: '**/*.ts', path: fixture },
          },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        [
          {
            type: 'tool_use',
            id: 'r1',
            name: 'read',
            input: { path: join(fixture, 'src', 'auth.ts') },
          },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        textEvents('鉴权逻辑在 src/auth.ts 的 authenticate 函数中。'),
      ]);
      const events: RuntimeEvent[] = [];
      const result = await runAgentTurn(
        {
          provider: stub,
          messages: [userMsg],
          tools,
          options: { maxTurns: 5 },
        },
        (event) => events.push(event),
      );

      expect(result.termination).toBe('end_turn');
      expect(result.turns).toBe(3);
      expect(result.text).toBe(
        '鉴权逻辑在 src/auth.ts 的 authenticate 函数中。',
      );

      // 第一轮 glob 结果回喂：第二轮请求里带 glob 的 tool-result（含 auth.ts）
      const second = stub.seenMessages[1];
      expect(second[2].role).toBe('tool');
      if (second[2].role !== 'tool') throw new Error('第二轮应带 tool 消息');
      const globOutput = second[2].content[0];
      expect(globOutput.type).toBe('tool-result');
      if (globOutput.type !== 'tool-result')
        throw new Error('glob 应产生 tool-result');
      expect(globOutput.toolCallId).toBe('g1');
      expect(globOutput.toolName).toBe('glob');
      // 管线产出的是 text / error-text 输出（带 value 字段）
      const globText =
        'value' in globOutput.output
          ? String(globOutput.output.value)
          : '<无文本>';
      expect(globText).toContain('auth.ts');

      // 第二轮 read 结果回喂：第三轮请求里带 read 的 tool-result（含文件内容）。
      // 线程按轮次累积：第三轮请求 = [user, assistant(g1), tool(g1),
      // assistant(r1), tool(r1)]，read 结果在索引 4。
      const third = stub.seenMessages[2];
      expect(third).toHaveLength(5);
      const readResult = third[4];
      expect(readResult.role).toBe('tool');
      if (readResult.role !== 'tool')
        throw new Error('第三轮应带 read 的 tool 消息');
      const readOutput = readResult.content[0];
      expect(readOutput.type).toBe('tool-result');
      if (readOutput.type !== 'tool-result')
        throw new Error('read 应产生 tool-result');
      expect(readOutput.toolCallId).toBe('r1');
      expect(readOutput.toolName).toBe('read');
      const readText =
        'value' in readOutput.output
          ? String(readOutput.output.value)
          : '<无文本>';
      expect(readText).toContain('authenticate');

      // 事件流：两条 tool_use + 两条 tool_result（均成功），无未知工具反馈
      expect(events.filter((e) => e.type === 'tool_use')).toHaveLength(2);
      const toolResults = events.filter((e) => e.type === 'tool_result');
      expect(toolResults).toHaveLength(2);
      expect(toolResults.every((e) => e.ok === true)).toBe(true);
      expect(events.some((e) => e.type === 'tool_feedback')).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 防盲写（T-030/T-031）的运行时生产者：loop 维护会话级已读集合，read 工具
// 经 ctx.onFileRead 上报成功读取；Write/Edit 据此放行。这里端到端验证
// read→edit 链路、跨轮次持续、入参种子与 cwd 下发。
// ---------------------------------------------------------------------------

describe('防盲写 readFiles 运行时生产者（loop 维护会话已读集合）', () => {
  /** 从事件流里取指定 id 的 tool_result（ok 与 forModel）。 */
  function toolResultById(
    events: RuntimeEvent[],
    id: string,
  ): { ok: boolean; forModel: string } | undefined {
    const event = events.find((e) => e.type === 'tool_result' && e.id === id);
    if (event === undefined || event.type !== 'tool_result') return undefined;
    return { ok: event.ok, forModel: event.forModel ?? '' };
  }

  /** 临时 fixture：一个目录 + 一个内容固定的目标文件。 */
  function makeFixture(content: string): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'modou-readfiles-'));
    const file = join(dir, 'target.ts');
    writeFileSync(file, content, 'utf8');
    return { dir, file };
  }

  /** 构造 edit 工具入参（目标文件 + 唯一替换）。 */
  function editInput(
    file: string,
    oldString: string,
    newString: string,
  ): Record<string, unknown> {
    return { path: file, old_string: oldString, new_string: newString };
  }

  test('同一轮次先 read 后 edit：readFiles 实时入集，edit 放行并执行', async () => {
    const { dir, file } = makeFixture('const value = 1;\n');
    try {
      const tools = defaultWriteTools();
      const stub = new StubProvider([
        [
          { type: 'tool_use', id: 'r1', name: 'read', input: { path: file } },
          {
            type: 'tool_use',
            id: 'e1',
            name: 'edit',
            input: editInput(file, 'const value = 1;', 'const value = 2;'),
          },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        textEvents('完成。'),
      ]);
      const events: RuntimeEvent[] = [];
      const result = await runAgentTurn(
        {
          provider: stub,
          messages: [userMsg],
          tools,
          options: { maxTurns: 5 },
        },
        (event) => events.push(event),
      );

      expect(result.termination).toBe('end_turn');
      expect(toolResultById(events, 'r1')?.ok).toBe(true);
      const edit = toolResultById(events, 'e1');
      expect(edit?.ok).toBe(true);
      expect(edit?.forModel).toContain('已替换');
      expect(readFileSync(file, 'utf8')).toBe('const value = 2;\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('同一轮次先 edit 后 read：edit 被拒（未读过），文件不被改动', async () => {
    const { dir, file } = makeFixture('const value = 1;\n');
    try {
      const tools = defaultWriteTools();
      const stub = new StubProvider([
        [
          {
            type: 'tool_use',
            id: 'e1',
            name: 'edit',
            input: editInput(file, 'const value = 1;', 'const value = 2;'),
          },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        [
          { type: 'tool_use', id: 'r1', name: 'read', input: { path: file } },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        textEvents('完成。'),
      ]);
      const events: RuntimeEvent[] = [];
      const result = await runAgentTurn(
        {
          provider: stub,
          messages: [userMsg],
          tools,
          options: { maxTurns: 5 },
        },
        (event) => events.push(event),
      );

      expect(result.termination).toBe('end_turn');
      const edit = toolResultById(events, 'e1');
      expect(edit?.ok).toBe(false);
      expect(edit?.forModel).toContain('未读取过');
      expect(toolResultById(events, 'r1')?.ok).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('const value = 1;\n'); // 未被改动
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('跨轮次：turn 1 read，turn 2 edit 仍放行（集合跨轮次持续）', async () => {
    const { dir, file } = makeFixture('const value = 1;\n');
    try {
      const tools = defaultWriteTools();
      const stub = new StubProvider([
        [
          { type: 'tool_use', id: 'r1', name: 'read', input: { path: file } },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        [
          {
            type: 'tool_use',
            id: 'e1',
            name: 'edit',
            input: editInput(file, 'const value = 1;', 'const value = 3;'),
          },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        textEvents('完成。'),
      ]);
      const events: RuntimeEvent[] = [];
      const result = await runAgentTurn(
        {
          provider: stub,
          messages: [userMsg],
          tools,
          options: { maxTurns: 5 },
        },
        (event) => events.push(event),
      );

      expect(result.termination).toBe('end_turn');
      expect(result.turns).toBe(3);
      const edit = toolResultById(events, 'e1');
      expect(edit?.ok).toBe(true);
      expect(edit?.forModel).toContain('已替换');
      expect(readFileSync(file, 'utf8')).toBe('const value = 3;\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('入参 readFiles 作种子：无需先读，edit 直接放行', async () => {
    const { dir, file } = makeFixture('const value = 1;\n');
    try {
      const tools = defaultWriteTools();
      const stub = new StubProvider([
        [
          {
            type: 'tool_use',
            id: 'e1',
            name: 'edit',
            input: editInput(file, 'const value = 1;', 'const value = 4;'),
          },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        textEvents('完成。'),
      ]);
      const events: RuntimeEvent[] = [];
      const result = await runAgentTurn(
        {
          provider: stub,
          messages: [userMsg],
          tools,
          readFiles: new Set([file]),
          options: { maxTurns: 5 },
        },
        (event) => events.push(event),
      );

      expect(result.termination).toBe('end_turn');
      const edit = toolResultById(events, 'e1');
      expect(edit?.ok).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('const value = 4;\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cwd 下发正确：工具 ctx.cwd 等于传入值', async () => {
    const cwdProbe: Tool = {
      name: 'cwd-probe',
      description: '返回当前工作目录（测试用）',
      risk: 'read',
      schema: z.object({}),
      execute: async (_args: unknown, ctx: ToolContext) => ({
        ok: true,
        forModel: `cwd=${ctx.cwd ?? '<undefined>'}`,
      }),
    };
    const tools = new ToolRegistry().register(cwdProbe);
    const expectedCwd = join(tmpdir(), 'modou-cwd-target');
    const stub = new StubProvider([
      [
        { type: 'tool_use', id: 'c1', name: 'cwd-probe', input: {} },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
        { type: 'finish', reason: 'tool_use' },
      ],
      textEvents('完成。'),
    ]);
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        tools,
        cwd: expectedCwd,
        options: { maxTurns: 5 },
      },
      (event) => events.push(event),
    );

    expect(result.termination).toBe('end_turn');
    const probe = toolResultById(events, 'c1');
    expect(probe?.ok).toBe(true);
    expect(probe?.forModel).toBe(`cwd=${expectedCwd}`);
  });
});
