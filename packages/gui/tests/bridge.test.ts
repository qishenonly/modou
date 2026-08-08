/**
 * GuiBridge 集成测试（离线）：注入 scripted stub provider + 临时目录，
 * 验证「submit → 事件流 → 会话落盘 → 线程查询 → 恢复 → 清空」整条链路。
 * 不访问外网、不读真实用户目录。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Envelope,
  ModelProvider,
  StreamChatInput,
  StreamEvent,
} from '@modou/core';
import { defaultReadonlyTools, ProviderError } from '@modou/core';
import { GuiBridge } from '../electron/bridge';
import type { ReadyPayload } from '../electron/ipc';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `modou-gui-${prefix}-`));
}

function stubProvider(
  script: () => Array<() => StreamEvent>,
  options: { readonly hangUntilAbort?: boolean } = {},
): ModelProvider {
  return {
    id: 'stub',
    modelId: 'stub-model',
    capabilities: {
      maxContext: 64_000,
      parallelToolCalls: true,
      cacheBreakpoints: false,
      images: false,
      thinking: 'none',
      strictJsonArgs: true,
    },
    async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
      if (options.hangUntilAbort === true) {
        yield { type: 'text_delta', delta: '…' };
        await new Promise<void>((resolve) => {
          if (input.abortSignal?.aborted) resolve();
          else {
            input.abortSignal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }
        });
        throw new ProviderError({ kind: 'aborted', message: '测试中断' });
      }
      for (const make of script()) yield make();
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeout = 4000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error('waitFor 超时：条件未满足');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface BridgeHarness {
  readonly bridge: GuiBridge;
  readonly envelopes: Envelope[];
  readonly readys: ReadyPayload[];
  readonly cleanup: () => void;
}

function createBridge(provider: ModelProvider): BridgeHarness {
  const home = makeTempDir('home');
  const cwd = makeTempDir('proj');
  const envelopes: Envelope[] = [];
  const readys: ReadyPayload[] = [];
  const bridge = new GuiBridge(
    { provider, cwd, homeDir: home, tools: defaultReadonlyTools() },
    {
      emitEvent: (envelope) => envelopes.push(envelope),
      emitReady: (payload) => readys.push(payload),
    },
    { OPENAI_API_KEY: 'test-key' },
  );
  const cleanup = (): void => {
    bridge.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  };
  return { bridge, envelopes, readys, cleanup };
}

function textOf(envelopes: readonly Envelope[]): string {
  return envelopes
    .filter((envelope) => envelope.type === 'text_delta')
    .map((envelope) => envelope.data.delta)
    .join('');
}

describe('GuiBridge（core 编排桥）', () => {
  test('start() 返回 ReadyPayload，并推送配置摘要', () => {
    const harness = createBridge(stubProvider(() => []));
    try {
      const ready = harness.bridge.start();
      expect(ready.modelName).toBe('stub-model');
      expect(ready.permissionMode).toBe('readonly'); // defaultReadonlyTools
      expect(ready.sessionId).toBeNull();
    } finally {
      harness.cleanup();
    }
  });

  test('submit → 事件流（turn_start / text_delta / usage / turn_end）', async () => {
    const harness = createBridge(
      stubProvider(() => [
        () => ({ type: 'text_delta' as const, delta: '你好，' }),
        () => ({ type: 'text_delta' as const, delta: '世界' }),
        () => ({
          type: 'usage' as const,
          usage: { inputTokens: 12, outputTokens: 3 },
        }),
        () => ({ type: 'finish' as const, reason: 'stop' as const }),
      ]),
    );
    try {
      harness.bridge.start();
      harness.bridge.sendCommand({ type: 'submit', text: '你好' });

      await waitFor(() =>
        harness.envelopes.some((envelope) => envelope.type === 'turn_end'),
      );

      const types = harness.envelopes.map((envelope) => envelope.type);
      expect(types).toContain('turn_start');
      expect(types).toContain('turn_end');
      expect(textOf(harness.envelopes)).toBe('你好，世界');

      const usage = harness.envelopes.find(
        (envelope) => envelope.type === 'usage',
      );
      expect(usage?.data.inputTokens).toBe(12);
      expect(usage?.data.outputTokens).toBe(3);
    } finally {
      harness.cleanup();
    }
  });

  test('轮次后：会话落盘可列举，getThread 返回完整线程', async () => {
    const harness = createBridge(
      stubProvider(() => [
        () => ({ type: 'text_delta' as const, delta: '完成' }),
        () => ({ type: 'finish' as const, reason: 'stop' as const }),
      ]),
    );
    try {
      harness.bridge.start();
      harness.bridge.sendCommand({ type: 'submit', text: '写个函数' });
      await waitFor(() =>
        harness.envelopes.some((envelope) => envelope.type === 'turn_end'),
      );

      const sessions = await harness.bridge.listSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0].preview).toContain('写个函数');

      const thread = harness.bridge.getThread();
      expect(thread).toEqual([
        { role: 'user', text: '写个函数' },
        { role: 'assistant', text: '完成' },
      ]);
    } finally {
      harness.cleanup();
    }
  });

  test('interrupt → turn_end 终止原因为 interrupted', async () => {
    const harness = createBridge(
      stubProvider(() => [], { hangUntilAbort: true }),
    );
    try {
      harness.bridge.start();
      harness.bridge.sendCommand({ type: 'submit', text: '停一下' });
      await waitFor(() =>
        harness.envelopes.some((envelope) => envelope.type === 'turn_start'),
      );
      harness.bridge.sendCommand({ type: 'interrupt' });

      await waitFor(() => {
        const turnEnd = harness.envelopes.find(
          (envelope) => envelope.type === 'turn_end',
        );
        return turnEnd !== undefined;
      });
      const turnEnd = harness.envelopes.find(
        (envelope) => envelope.type === 'turn_end',
      );
      expect(turnEnd?.data.termination).toBe('interrupted');
    } finally {
      harness.cleanup();
    }
  });

  test('slash resume：按 ID 恢复并重建线程，READY 携带 totals', async () => {
    const harness = createBridge(
      stubProvider(() => [
        () => ({ type: 'text_delta' as const, delta: '第一轮' }),
        () => ({ type: 'finish' as const, reason: 'stop' as const }),
      ]),
    );
    try {
      harness.bridge.start();
      harness.bridge.sendCommand({ type: 'submit', text: '第一次' });
      await waitFor(() =>
        harness.envelopes.some((envelope) => envelope.type === 'turn_end'),
      );
      const sessions = await harness.bridge.listSessions();

      harness.bridge.sendCommand({
        type: 'slash',
        name: 'resume',
        args: sessions[0].sessionId,
      });
      await waitFor(() =>
        harness.readys.some(
          (ready) => ready.sessionId === sessions[0].sessionId,
        ),
      );

      const thread = harness.bridge.getThread();
      expect(thread.map((message) => message.text)).toContain('第一次');
      const ready = harness.readys.at(-1);
      expect(ready?.totals).toBeDefined();
    } finally {
      harness.cleanup();
    }
  });

  test('slash clear：开启新会话，线程清空', async () => {
    const harness = createBridge(
      stubProvider(() => [
        () => ({ type: 'text_delta' as const, delta: '回复' }),
        () => ({ type: 'finish' as const, reason: 'stop' as const }),
      ]),
    );
    try {
      harness.bridge.start();
      harness.bridge.sendCommand({ type: 'submit', text: '旧对话' });
      await waitFor(() =>
        harness.envelopes.some((envelope) => envelope.type === 'turn_end'),
      );
      expect(harness.bridge.getThread().length).toBe(2);

      harness.bridge.sendCommand({ type: 'slash', name: 'clear' });
      await waitFor(() => harness.bridge.getThread().length === 0);
      expect(harness.bridge.getConfig().sessionId).not.toBeNull();
    } finally {
      harness.cleanup();
    }
  });

  test('getContext 返回分项核算（不抛错）', () => {
    const harness = createBridge(stubProvider(() => []));
    try {
      harness.bridge.start();
      const context = harness.bridge.getContext();
      expect(context.total).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(context.sections)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });
});
