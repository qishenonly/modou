import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import type { ProviderCapabilities } from '../provider/capabilities';
import { ProviderError } from '../provider/errors';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
} from '../provider/types';
import { runAgentTurn } from './loop';
import { computeBackoffDelay, withRetry } from './retry';

// ---------------------------------------------------------------------------
// 重试行为测试（T-014：指数退避重试）
//
// withRetry 直接测试：控制 attempt 回调返回「第几次尝试吐什么」，
// 用 0 延迟 / 固定抖动得到确定性结果。
// ---------------------------------------------------------------------------

const noDelay = { sleep: async () => {} };
const noJitter = { random: () => 0 };

function textEvents(text: string): StreamEvent[] {
  return [
    ...Array.from(text).map((char) => ({
      type: 'text_delta' as const,
      delta: char,
    })),
    { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish' as const, reason: 'stop' as const },
  ];
}

async function collect(
  retryable: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of retryable) events.push(event);
  return events;
}

function joinText(events: StreamEvent[]): string {
  return events
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.delta)
    .join('');
}

/** 把一次性 AsyncIterable 包装成 attempt 回调，并记录每次尝试的序号。 */
function makeAttempt(
  rounds: Array<StreamEvent[] | { readonly throw: unknown }>,
  calls: number[],
): (attemptNumber: number) => AsyncIterable<StreamEvent> {
  return (attemptNumber) => {
    calls.push(attemptNumber);
    const round = rounds[Math.min(attemptNumber - 1, rounds.length - 1)];
    if (round !== undefined && 'throw' in round) {
      const error = round.throw;
      return (async function* () {
        throw error;
      })();
    }
    const events = round as StreamEvent[];
    return (async function* () {
      for (const event of events) yield event;
    })();
  };
}

describe('computeBackoffDelay（退避曲线）', () => {
  test('指数增长：500 / 1000 / 2000 / 4000，到达上限后封顶', () => {
    const options = { baseDelayMs: 500, maxDelayMs: 8000, jitterFactor: 0 };
    expect(computeBackoffDelay(1, options)).toBe(500);
    expect(computeBackoffDelay(2, options)).toBe(1000);
    expect(computeBackoffDelay(3, options)).toBe(2000);
    expect(computeBackoffDelay(4, options)).toBe(4000);
    expect(computeBackoffDelay(5, options)).toBe(8000); // 封顶
    expect(computeBackoffDelay(6, options)).toBe(8000);
  });

  test('抖动：random()=0 无抖动，random()=1 翻倍（×2）', () => {
    expect(
      computeBackoffDelay(1, {
        baseDelayMs: 500,
        jitterFactor: 0.5,
        random: () => 0,
      }),
    ).toBe(500);
    expect(
      computeBackoffDelay(1, {
        baseDelayMs: 500,
        jitterFactor: 0.5,
        random: () => 1,
      }),
    ).toBe(750);
    expect(
      computeBackoffDelay(2, {
        baseDelayMs: 500,
        jitterFactor: 0.5,
        random: () => 0.5,
      }),
    ).toBe(1250); // 1000 × (1 + 0.25)
  });
});

describe('withRetry（指数退避重试）', () => {
  test('429 后重试成功：首次抛 rate_limited，第二次正常收尾', async () => {
    const calls: number[] = [];
    const attempt = makeAttempt(
      [
        { throw: new ProviderError({ kind: 'rate_limited', message: '限流' }) },
        textEvents('你好'),
      ],
      calls,
    );

    const events = await collect(
      withRetry(attempt, { ...noDelay, ...noJitter }),
    );

    expect(calls).toEqual([1, 2]);
    expect(joinText(events)).toBe('你好');
  });

  test('重试耗尽：持续 429 → 抛出的错误带「重试 N 次仍失败」且分类保留', async () => {
    const calls: number[] = [];
    const attempt = makeAttempt(
      [{ throw: new ProviderError({ kind: 'rate_limited', message: '限流' }) }],
      calls,
    );

    const promise = collect(
      withRetry(attempt, { maxAttempts: 3, ...noDelay, ...noJitter }),
    );
    await expect(promise).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      message: expect.stringContaining('重试 2 次仍失败'),
    });
    expect(calls).toEqual([1, 2, 3]);
  });

  test('已产出内容后失败不重试（避免内容重复 / 事件断裂）', async () => {
    const calls: number[] = [];
    const error = new ProviderError({
      kind: 'server_error',
      message: '产出后失败',
    });
    const attempt = (attemptNumber: number): AsyncIterable<StreamEvent> => {
      calls.push(attemptNumber);
      return (async function* () {
        yield { type: 'text_delta', delta: '部分' };
        throw error;
      })();
    };

    const promise = collect(
      withRetry(attempt, { maxAttempts: 5, ...noDelay, ...noJitter }),
    );
    await expect(promise).rejects.toBe(error);
    expect(calls).toEqual([1]); // 只尝试一次
  });

  test('非 retryable 错误不重试（invalid_api_key 直接抛）', async () => {
    const calls: number[] = [];
    const error = new ProviderError({
      kind: 'invalid_api_key',
      message: 'key 无效',
    });
    const attempt = makeAttempt([{ throw: error }], calls);

    const promise = collect(
      withRetry(attempt, { maxAttempts: 5, ...noDelay, ...noJitter }),
    );
    await expect(promise).rejects.toBe(error);
    expect(calls).toEqual([1]);
  });

  test('timeout 属可重试：超时一次后成功', async () => {
    const calls: number[] = [];
    const attempt = makeAttempt(
      [
        { throw: new ProviderError({ kind: 'timeout', message: '超时' }) },
        textEvents('恢复'),
      ],
      calls,
    );

    const events = await collect(
      withRetry(attempt, { ...noDelay, ...noJitter }),
    );

    expect(calls).toEqual([1, 2]);
    expect(joinText(events)).toBe('恢复');
  });

  test('中断（aborted）不重试，原样上抛', async () => {
    const calls: number[] = [];
    const aborted = new ProviderError({
      kind: 'aborted',
      message: '请求已被中断',
    });
    const attempt = makeAttempt([{ throw: aborted }], calls);

    const promise = collect(
      withRetry(attempt, { maxAttempts: 5, ...noDelay, ...noJitter }),
    );
    await expect(promise).rejects.toBe(aborted);
    expect(calls).toEqual([1]);
  });

  test('退避期间 abort 立即停止，不留悬挂等待', async () => {
    const controller = new AbortController();
    const calls: number[] = [];
    const attempt = makeAttempt(
      [{ throw: new ProviderError({ kind: 'rate_limited', message: '限流' }) }],
      calls,
    );

    // baseDelayMs=5000：若非可中断等待，第二次尝试要等满 5 秒才发生
    const startedAt = Date.now();
    const promise = collect(
      withRetry(attempt, {
        maxAttempts: 3,
        baseDelayMs: 5000,
        jitterFactor: 0,
        abortSignal: controller.signal,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(calls).toEqual([1]); // 只发起过一次请求
  });
});

// ---------------------------------------------------------------------------
// loop 集成：withRetry 接进 runAgentTurn 后的整体行为
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

/** 按调用顺序消费 rounds 的假 Provider；用尽后重放最后一轮。 */
class RetryingStub implements ModelProvider {
  readonly id = 'stub';
  readonly modelId = 'stub-model';
  readonly capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES;
  readonly seenMessages: ModelMessage[][] = [];
  private callCount = 0;

  constructor(
    private readonly rounds: Array<StreamEvent[] | { readonly throw: unknown }>,
  ) {}

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    this.seenMessages.push(input.messages);
    const round = this.rounds[Math.min(this.callCount, this.rounds.length - 1)];
    this.callCount += 1;
    if ('throw' in round) throw round.throw;
    for (const event of round) yield event;
  }
}

const userMsg: ModelMessage = { role: 'user', content: '你好' };

describe('runAgentTurn + withRetry（loop 层重试）', () => {
  test('限流后重试成功：一次 turn 内完成，文本与 usage 完整', async () => {
    const stub = new RetryingStub([
      { throw: new ProviderError({ kind: 'rate_limited', message: '限流' }) },
      textEvents('你好'),
    ]);
    const result = await runAgentTurn({
      provider: stub,
      messages: [userMsg],
      options: {
        maxTurns: 5,
        retry: { sleep: async () => {}, random: () => 0 },
      },
    });

    expect(result.termination).toBe('end_turn');
    expect(result.state).toBe('idle');
    expect(result.turns).toBe(1); // 重试在单轮内，不计为新轮次
    expect(result.text).toBe('你好');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(stub.seenMessages).toHaveLength(2);
  });

  test('重试耗尽（持续 5xx）：error 终止，错误带已重试说明', async () => {
    const stub = new RetryingStub([
      {
        throw: new ProviderError({ kind: 'server_error', message: '上游 500' }),
      },
    ]);
    const result = await runAgentTurn({
      provider: stub,
      messages: [userMsg],
      options: {
        maxTurns: 5,
        retry: { maxAttempts: 3, sleep: async () => {}, random: () => 0 },
      },
    });

    expect(result.termination).toBe('error');
    expect(result.state).toBe('halted');
    expect(result.turns).toBe(1);
    expect(result.error?.kind).toBe('server_error');
    expect(result.error?.message).toContain('重试 2 次仍失败');
    expect(stub.seenMessages).toHaveLength(3);
  });

  test('已产出部分文本后失败：不重试，error 终止且保留已产文本', async () => {
    const serverError = new ProviderError({
      kind: 'server_error',
      message: '流中断',
    });
    let requests = 0;
    // 自定义 provider：先吐两段文本再抛错，且统计请求次数
    const partialProvider: ModelProvider = {
      id: 'partial',
      modelId: 'partial-model',
      capabilities: DEFAULT_CAPABILITIES,
      async *streamChat(): AsyncIterable<StreamEvent> {
        requests += 1;
        yield { type: 'text_delta', delta: '部分' };
        yield { type: 'text_delta', delta: '回答' };
        throw serverError;
      },
    };

    const result = await runAgentTurn({
      provider: partialProvider,
      messages: [userMsg],
      options: {
        maxTurns: 5,
        retry: { maxAttempts: 3, sleep: async () => {}, random: () => 0 },
      },
    });

    expect(result.termination).toBe('error');
    expect(result.text).toBe('部分回答'); // 已产文本保留
    expect(result.error).toBe(serverError);
    expect(requests).toBe(1); // 不重试
  });

  test('非 retryable 错误直接终止，不消耗重试次数', async () => {
    const stub = new RetryingStub([
      {
        throw: new ProviderError({
          kind: 'invalid_api_key',
          message: 'key 无效',
        }),
      },
    ]);
    const result = await runAgentTurn({
      provider: stub,
      messages: [userMsg],
      options: {
        maxTurns: 5,
        retry: { maxAttempts: 3, sleep: async () => {}, random: () => 0 },
      },
    });

    expect(result.termination).toBe('error');
    expect(result.error?.kind).toBe('invalid_api_key');
    expect(stub.seenMessages).toHaveLength(1); // 只请求一次
  });
});
