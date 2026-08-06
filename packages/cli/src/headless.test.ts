import { describe, expect, test } from 'bun:test';
import { ProviderError } from '@modou/core';
import type {
  ModelProvider,
  ProviderCapabilities,
  StreamEvent,
} from '@modou/core';
import { runHeadless } from './headless';

// ---------------------------------------------------------------------------
// 测试替身：本地假 Provider（端到端 headless 输出，不访问外网）
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
  private callCount = 0;

  constructor(private readonly rounds: StubRound[]) {}

  async *streamChat(): AsyncIterable<StreamEvent> {
    const round = this.rounds[Math.min(this.callCount, this.rounds.length - 1)];
    this.callCount += 1;
    if ('throw' in round) throw round.throw;
    for (const event of round) yield event;
  }
}

describe('runHeadless（`modou -p` 的 headless 输出）', () => {
  test('text_delta 流式写入 stdout，usage 摘要与终止信息写入 stderr', async () => {
    const stub = new StubProvider([
      [
        { type: 'text_delta', delta: '你' },
        { type: 'text_delta', delta: '好' },
        { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
        { type: 'finish', reason: 'stop' },
      ],
    ]);

    let stdout = '';
    let stderr = '';
    const { result, envelopes } = await runHeadless({
      provider: stub,
      prompt: '你好',
      write: (chunk) => {
        stdout += chunk;
      },
      writeError: (chunk) => {
        stderr += chunk;
      },
    });

    // stdout 是纯回答文本
    expect(stdout).toBe('你好');
    expect(stderr).toContain('输入 7 token');
    expect(stderr).toContain('输出 3 token');

    expect(result.termination).toBe('end_turn');
    expect(result.text).toBe('你好');

    // 协议信封完整产出（turn_start 开路，turn_end 收尾）
    expect(envelopes[0].type).toBe('turn_start');
    expect(envelopes[envelopes.length - 1].type).toBe('turn_end');
    expect(envelopes.some((e) => e.type === 'usage')).toBe(true);
  });

  test('stdout 保持纯回答：usage 摘要不混入（写入 out.txt 是干净答案）', async () => {
    const stub = new StubProvider([
      [
        { type: 'text_delta', delta: '答案是 42' },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
        { type: 'finish', reason: 'stop' },
      ],
    ]);

    let stdout = '';
    let stderr = '';
    await runHeadless({
      provider: stub,
      prompt: 'hi',
      write: (chunk) => {
        stdout += chunk;
      },
      writeError: (chunk) => {
        stderr += chunk;
      },
    });

    expect(stdout).toBe('答案是 42');
    expect(stdout).not.toContain('token');
    expect(stderr).toContain('token');
  });

  test('provider 抛错：stderr 报错，termination = error', async () => {
    const stub = new StubProvider([
      {
        throw: new ProviderError({ kind: 'server_error', message: '上游 500' }),
      },
    ]);

    let stdout = '';
    let stderr = '';
    const { result } = await runHeadless({
      provider: stub,
      prompt: 'hi',
      write: (chunk) => {
        stdout += chunk;
      },
      writeError: (chunk) => {
        stderr += chunk;
      },
    });

    expect(result.termination).toBe('error');
    expect(stdout).toBe('');
    expect(stderr).toContain('上游 500');
  });

  test('max_turns 上限：halted 终止并在 stderr 提示', async () => {
    const stub = new StubProvider([
      [
        { type: 'tool_use', id: 'c1', name: 'bash', input: { cmd: 'ls' } },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish', reason: 'tool_use' },
      ],
    ]);

    let stderr = '';
    const { result } = await runHeadless({
      provider: stub,
      prompt: 'hi',
      maxTurns: 1,
      write: () => {},
      writeError: (chunk) => {
        stderr += chunk;
      },
    });

    expect(result.termination).toBe('halted');
    expect(stderr).toContain('达到轮次/预算上限');
  });
});
