import type {
  ModelProvider,
  ProviderCapabilities,
  StreamChatInput,
  StreamEvent,
} from '@modou/core';
import { runHeadless } from './headless';
import { createSignalInterrupt, signalToExitCode } from './signals';

/**
 * 子进程 fixture（signals.test.ts 的 SIGINT 端到端验证用，非测试文件）。
 *
 * 流程：产出部分文本后挂起 → 收到 SIGINT 被 abort → 以 128+信号号退出，
 * 把已产文本留在 stdout、中断提示留在 stderr。用真实信号 + 真实进程验证
 * 「发送 SIGINT → 运行中断 → 已产文本输出 → 正确退出码」这条链。
 */

const CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

/** 产出「部分回答」后挂起，直到 abort 信号到达的假 Provider。 */
class HangingProvider implements ModelProvider {
  readonly id = 'fixture';
  readonly modelId = 'fixture-model';
  readonly capabilities: ProviderCapabilities = CAPABILITIES;

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', delta: '部分' };
    yield { type: 'text_delta', delta: '回答' };
    // 产出后挂起：真实 provider 在等待下一段流式输出时的形态
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        input.abortSignal?.removeEventListener('abort', onAbort);
        const error = Object.assign(new Error('请求已被中断'), {
          name: 'AbortError',
        });
        reject(error);
      };
      if (input.abortSignal === undefined) {
        return; // 理论不可达：loop 总会传信号
      }
      if (input.abortSignal.aborted) {
        onAbort();
        return;
      }
      input.abortSignal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

const interrupt = createSignalInterrupt(['SIGINT', 'SIGTERM']);
const { result } = await runHeadless({
  provider: new HangingProvider(),
  prompt: 'hi',
  abortSignal: interrupt.signal,
});

if (result.termination === 'interrupted' && interrupt.triggered !== undefined) {
  process.exitCode = signalToExitCode(interrupt.triggered);
} else {
  process.exitCode = result.termination === 'error' ? 1 : 0;
}
interrupt.dispose();
