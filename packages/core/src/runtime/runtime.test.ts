import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import type { ProviderCapabilities } from '../provider/capabilities';
import { ProviderError } from '../provider/errors';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
  TokenUsage,
} from '../provider/types';
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

function toolUseEvents(name = 'bash', id = 'call-1'): StreamEvent[] {
  return [
    { type: 'tool_use', id, name, input: { cmd: 'ls' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: 'tool_use' },
  ];
}

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

  test('provider 抛错 → error 终止，归一错误保留', async () => {
    const serverError = new ProviderError({
      kind: 'server_error',
      message: '上游 500',
    });
    const stub = new StubProvider([{ throw: serverError }]);
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      { provider: stub, messages: [userMsg], options: { maxTurns: 5 } },
      (event) => events.push(event),
    );

    expect(result.termination).toBe('error');
    expect(result.state).toBe('halted');
    expect(result.turns).toBe(1);
    expect(result.error).toBe(serverError);
    expect(result.text).toBe('');
    expect(events).toContainEqual({ type: 'error', error: serverError });
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
