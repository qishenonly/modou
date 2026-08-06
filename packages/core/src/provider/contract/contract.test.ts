import { describe, expect, test } from 'bun:test';
import type { ModelProvider, StreamChatInput, StreamEvent } from '../types';

/**
 * 契约测试的「选手」：每个适配器（anthropic / openai-compat 等）提供
 * 一组 ModelProvider 实例，同一套用例在这些实例上逐一运行。
 */
export interface ContractProviderBundle {
  /** 正常流式实例：text_delta / finish / usage / abort 用例都跑它。 */
  readonly provider: ModelProvider;
  /**
   * 抛 429 的实例：错误归一用例跑它。
   * 缺省复用 provider（适合无法单独构造错误实例的场景）。
   */
  readonly error429Provider?: ModelProvider;
}

/** 把流式事件全部收集成数组。 */
export async function collect(
  provider: ModelProvider,
  input: StreamChatInput,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.streamChat(input)) {
    events.push(event);
  }
  return events;
}

const chatInput: StreamChatInput = {
  messages: [{ role: 'user' as const, content: '你好' }],
};

/**
 * 契约测试工厂（关键交付物）。
 *
 * 每组用例覆盖五个契约点：text_delta 产出、finish 收尾、usage 上报、
 * abort 可中断、429 错误归一。所有适配器共用这份用例 —— 供应商差异
 * 必须表现为能力描述的不同，而不是某个适配器「跳过」某个用例。
 */
export function runContractTests(
  name: string,
  bundle: ContractProviderBundle,
): void {
  const error429Provider = bundle.error429Provider ?? bundle.provider;

  describe(`契约测试：${name}`, () => {
    test('streamChat 产出 text_delta', async () => {
      const events = await collect(bundle.provider, chatInput);
      const deltas = events.filter((event) => event.type === 'text_delta');
      expect(deltas.length).toBeGreaterThan(0);
      const joined = deltas.map((event) => event.delta).join('');
      expect(joined.length).toBeGreaterThan(0);
    });

    test('以 finish 收尾且 reason 为 stop', async () => {
      const events = await collect(bundle.provider, chatInput);
      const finish = events.find((event) => event.type === 'finish');
      expect(finish?.type).toBe('finish');
      if (finish?.type === 'finish') {
        expect(finish.reason).toBe('stop');
      }
      expect(events[events.length - 1]?.type).toBe('finish');
    });

    test('usage 上报（input / output token 分项可用）', async () => {
      const events = await collect(bundle.provider, chatInput);
      const usage = events.find((event) => event.type === 'usage');
      expect(usage?.type).toBe('usage');
      if (usage?.type === 'usage') {
        expect(usage.usage.inputTokens).toBeGreaterThanOrEqual(0);
        expect(usage.usage.outputTokens).toBeGreaterThanOrEqual(0);
      }
    });

    test('abort 可中断：预中断信号导致抛 ProviderError(aborted)', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        collect(bundle.provider, {
          ...chatInput,
          abortSignal: controller.signal,
        }),
      ).rejects.toMatchObject({ kind: 'aborted' });
    });

    test('错误归一：供应商 429 被分类为 rate_limited（可重试）', async () => {
      const promise = collect(error429Provider, {
        ...chatInput,
        maxRetries: 0,
      });
      await expect(promise).rejects.toMatchObject({
        kind: 'rate_limited',
        statusCode: 429,
        retryable: true,
      });
    });
  });
}
