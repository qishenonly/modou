import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type {
  ModelProvider,
  ProviderCapabilities,
  StreamChatInput,
  StreamEvent,
} from '@modou/core';
import { runHeadless } from './headless';
import { createSignalInterrupt, signalToExitCode } from './signals';

// ---------------------------------------------------------------------------
// 信号中断（T-014：SIGINT / SIGTERM 干净中断）
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('createSignalInterrupt（信号 → AbortSignal）', () => {
  test('SIGINT 触发 abort（reason=SIGINT），triggered 记录信号名', () => {
    const emitter = new EventEmitter();
    const handle = createSignalInterrupt(['SIGINT', 'SIGTERM'], { emitter });

    expect(handle.triggered).toBeUndefined();
    expect(handle.signal.aborted).toBe(false);

    emitter.emit('SIGINT');

    expect(handle.triggered).toBe('SIGINT');
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe('SIGINT');
    handle.dispose();
  });

  test('首个信号决定 triggered，后续信号忽略', () => {
    const emitter = new EventEmitter();
    const handle = createSignalInterrupt(['SIGINT', 'SIGTERM'], { emitter });

    emitter.emit('SIGTERM');
    expect(handle.triggered).toBe('SIGTERM');

    emitter.emit('SIGINT');
    expect(handle.triggered).toBe('SIGTERM'); // 已中断过，忽略
    handle.dispose();
  });

  test('dispose 后不再触发 abort（监听器清理干净）', () => {
    const emitter = new EventEmitter();
    const handle = createSignalInterrupt(['SIGINT'], { emitter });
    handle.dispose();

    emitter.emit('SIGINT');

    expect(handle.triggered).toBeUndefined();
    expect(handle.signal.aborted).toBe(false);
  });

  test('signalToExitCode：POSIX 惯例 128+信号号', () => {
    expect(signalToExitCode('SIGINT')).toBe(130); // SIGINT 编号 2
    expect(signalToExitCode('SIGTERM')).toBe(143); // SIGTERM 编号 15
  });
});

// ---------------------------------------------------------------------------
// 函数级：信号 → abort → runHeadless 中断贯通
// ---------------------------------------------------------------------------

const CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

/** 产出部分文本后挂起，直到 abort 的假 Provider（与 signal-fixture 同款）。 */
class HangingProvider implements ModelProvider {
  readonly id = 'hang';
  readonly modelId = 'hang-model';
  readonly capabilities: ProviderCapabilities = CAPABILITIES;

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', delta: '部分' };
    yield { type: 'text_delta', delta: '回答' };
    await new Promise<void>((_resolve, reject) => {
      const onAbort = (): void => {
        input.abortSignal?.removeEventListener('abort', onAbort);
        reject(
          Object.assign(new Error('请求已被中断'), { name: 'AbortError' }),
        );
      };
      if (input.abortSignal?.aborted) {
        onAbort();
        return;
      }
      input.abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

describe('信号中断贯通 runHeadless（函数级）', () => {
  test('发出 SIGINT → 运行中断为 interrupted，已产文本保留、中断原因携带信号名', async () => {
    const emitter = new EventEmitter();
    const handle = createSignalInterrupt(['SIGINT'], { emitter });
    let stdout = '';
    let stderr = '';

    const pending = runHeadless({
      provider: new HangingProvider(),
      prompt: 'hi',
      abortSignal: handle.signal,
      write: (chunk) => {
        stdout += chunk;
      },
      writeError: (chunk) => {
        stderr += chunk;
      },
    });

    // 等部分文本产出后发信号（模拟用户在回答中途按 Ctrl-C）
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (stdout.includes('部分回答')) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });

    emitter.emit('SIGINT');
    const { result } = await pending;

    expect(result.termination).toBe('interrupted');
    expect(result.text).toBe('部分回答');
    expect(result.interruptedReason).toBe('SIGINT');
    expect(stderr).toContain('已中断');
    handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// 端到端：真实子进程 + 真实信号
// ---------------------------------------------------------------------------

describe('SIGINT 端到端（真实子进程）', () => {
  test('发送 SIGINT → 退出码 130，stdout 保留已产文本，stderr 提示已中断', async () => {
    const fixture = join(import.meta.dir, 'signal-fixture.ts');
    const child = spawn(process.execPath, [fixture], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // 屏蔽 live 凭据：fixture 本身不触网，这里是双保险
        MODOU_OPENCODE_API_KEY: '',
        MODOU_TEST_MODEL_DEEPSEEK: '',
        MODOU_TEST_MODEL_GPT: '',
        MODOU_OPENCODE_BASE_URL: '',
      },
    });

    let stdout = '';
    let stderr = '';
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    // 等 fixture 产出「部分回答」（挂起状态）后再发 SIGINT
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (stdout.includes('部分回答')) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (child.exitCode !== null) {
          clearInterval(timer);
          reject(
            new Error(
              `fixture 提前退出（code=${child.exitCode}）stderr=${stderr}`,
            ),
          );
          return;
        }
        if (Date.now() - started > 10_000) {
          clearInterval(timer);
          reject(new Error('fixture 未在超时内产出「部分回答」'));
        }
      }, 10);
    });

    child.kill('SIGINT');
    const code = await exited;

    expect(code).toBe(130);
    expect(stdout).toContain('部分回答');
    expect(stderr).toContain('已中断');
  });
});
