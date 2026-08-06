import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import type { ProviderCapabilities } from '../provider/capabilities';
import { ProviderError } from '../provider/errors';
import type { ModelProvider, StreamEvent } from '../provider/types';
import { mapRuntimeEvent, runTurnWithProtocol } from './bridge';
import { EnvelopeEmitter } from './envelope';
import type { Envelope, EventType, ProtocolEvent } from './events';

// ---------------------------------------------------------------------------
// 测试替身：本地假 Provider（不访问外网，与 runtime.test 同款最小实现）
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

const userMsg: ModelMessage = { role: 'user', content: '你好' };

function textRound(text: string): StreamEvent[] {
  return [
    ...Array.from(text).map((char) => ({
      type: 'text_delta' as const,
      delta: char,
    })),
    { type: 'usage' as const, usage: { inputTokens: 7, outputTokens: 3 } },
    { type: 'finish' as const, reason: 'stop' as const },
  ];
}

// ---------------------------------------------------------------------------
// EnvelopeEmitter
// ---------------------------------------------------------------------------

describe('EnvelopeEmitter（信封公共字段）', () => {
  test('seq 单调递增、turn 跟随 turn_start、agent 默认 main、ts 来自注入时钟', () => {
    let now = 1_000;
    const emitter = new EnvelopeEmitter({ now: () => now });

    const e1 = emitter.emit({ type: 'turn_start', data: { turn: 1 } });
    expect(e1.v).toBe(1);
    expect(e1.seq).toBe(1);
    expect(e1.turn).toBe(1);
    expect(e1.agent).toBe('main');
    expect(e1.ts).toBe(1_000);

    now = 2_000;
    const e2 = emitter.emit({ type: 'text_delta', data: { delta: '你' } });
    expect(e2.seq).toBe(2);
    expect(e2.turn).toBe(1); // 沿用 turn_start 建立的轮次
    expect(e2.ts).toBe(2_000);

    const e3 = emitter.emit({ type: 'turn_start', data: { turn: 2 } });
    expect(e3.seq).toBe(3);
    expect(e3.turn).toBe(2);

    const e4 = emitter.emit({
      type: 'turn_end',
      data: { turn: 2, termination: 'end_turn' },
    });
    expect(e4.seq).toBe(4);
    expect(e4.turn).toBe(2);
  });

  test('agent 可自定义（0.12.0 子代理占位）；无 turn 事件时用起始轮次', () => {
    const emitter = new EnvelopeEmitter({
      agent: 'sub',
      turn: 3,
      now: () => 1,
    });
    const envelope = emitter.emit({
      type: 'notice',
      data: { level: 'info', text: 'hi' },
    });
    expect(envelope.agent).toBe('sub');
    expect(envelope.turn).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// bridge 映射（RuntimeEvent → 协议事件）
// ---------------------------------------------------------------------------

describe('bridge 映射', () => {
  test('逐事件映射正确（text/thinking/tool_use/usage/turn_start/turn_end）', () => {
    expect(mapRuntimeEvent({ type: 'turn_start', turn: 1 })).toEqual([
      { type: 'turn_start', data: { turn: 1 } },
    ]);
    expect(mapRuntimeEvent({ type: 'text_delta', delta: '你' })).toEqual([
      { type: 'text_delta', data: { delta: '你' } },
    ]);
    expect(mapRuntimeEvent({ type: 'thinking_delta', delta: '想' })).toEqual([
      { type: 'thinking_delta', data: { delta: '想' } },
    ]);
    expect(
      mapRuntimeEvent({
        type: 'tool_use',
        id: 'call-1',
        name: 'bash',
        input: { cmd: 'ls' },
      }),
    ).toEqual([
      {
        type: 'tool_call',
        data: { id: 'call-1', name: 'bash', input: { cmd: 'ls' } },
      },
    ]);
    expect(
      mapRuntimeEvent({
        type: 'usage',
        usage: { inputTokens: 3, outputTokens: 2 },
      }),
    ).toEqual([{ type: 'usage', data: { inputTokens: 3, outputTokens: 2 } }]);
    expect(
      mapRuntimeEvent({ type: 'turn_end', turn: 1, termination: 'end_turn' }),
    ).toEqual([
      { type: 'turn_end', data: { turn: 1, termination: 'end_turn' } },
    ]);
  });

  test('error → ErrorData（分类/细分/可恢复/说明）', () => {
    const error = new ProviderError({
      kind: 'server_error',
      message: '上游 500',
    });
    expect(mapRuntimeEvent({ type: 'error', error })).toEqual([
      {
        type: 'error',
        data: {
          category: 'provider',
          kind: 'server_error',
          recoverable: true,
          message: '上游 500',
        },
      },
    ]);
  });

  test('tool_feedback → notice（warn）：未知工具提示', () => {
    expect(
      mapRuntimeEvent({
        type: 'tool_feedback',
        id: 'call-1',
        name: 'bash',
        error: '未知工具 "bash"',
      }),
    ).toEqual([
      {
        type: 'notice',
        data: {
          level: 'warn',
          text: expect.stringContaining('未知工具 "bash"'),
        },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 端到端：runTurnWithProtocol（核心内闭环，不访问外网）
// ---------------------------------------------------------------------------

describe('runTurnWithProtocol（收集式桥接）', () => {
  test('正常文本流：信封 seq 连续、事件序列完整、turn_end 带终止原因', async () => {
    const stub = new StubProvider([textRound('你好')]);
    const { envelopes, result } = await runTurnWithProtocol({
      provider: stub,
      messages: [userMsg],
      options: { maxTurns: 5 },
    });

    expect(result.termination).toBe('end_turn');
    expect(result.state).toBe('idle');
    expect(result.text).toBe('你好');

    // seq 严格连续递增（前端排序/去重依赖它）
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(envelopes.map((e) => e.type)).toEqual([
      'turn_start',
      'text_delta',
      'text_delta',
      'usage',
      'turn_end',
    ]);
    expect(envelopes.map((e) => e.turn)).toEqual([1, 1, 1, 1, 1]);
    expect(envelopes[envelopes.length - 1].data).toEqual({
      turn: 1,
      termination: 'end_turn',
    });
  });

  test('tool_use 轮 → tool_call 信封 + 未知工具 notice，第二轮正常收尾', async () => {
    const stub = new StubProvider([
      [
        {
          type: 'tool_use' as const,
          id: 'call-1',
          name: 'bash',
          input: { cmd: 'ls' },
        },
        { type: 'usage' as const, usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish' as const, reason: 'tool_use' as const },
      ],
      textRound('好的'),
    ]);
    const { envelopes, result } = await runTurnWithProtocol({
      provider: stub,
      messages: [userMsg],
      options: { maxTurns: 5 },
    });

    expect(result.termination).toBe('end_turn');
    expect(result.turns).toBe(2);

    const toolCall = envelopes.find((e) => e.type === 'tool_call');
    expect(toolCall).toBeDefined();
    expect(
      (toolCall as Envelope<Extract<ProtocolEvent, { type: 'tool_call' }>>)
        .data,
    ).toEqual({ id: 'call-1', name: 'bash', input: { cmd: 'ls' } });

    const notice = envelopes.find((e) => e.type === 'notice');
    expect(notice).toBeDefined();
    expect(
      (notice as Envelope<Extract<ProtocolEvent, { type: 'notice' }>>).data,
    ).toEqual({
      level: 'warn',
      text: expect.stringContaining('未知工具 "bash"'),
    });

    // 跨轮次信封：turn 1（含未知工具回喂的 notice）与 turn 2 各归其位
    expect(envelopes.filter((e) => e.turn === 1).map((e) => e.type)).toEqual([
      'turn_start',
      'tool_call',
      'usage',
      'notice',
    ]);
    expect(envelopes.filter((e) => e.turn === 2).map((e) => e.type)).toEqual([
      'turn_start',
      'text_delta',
      'text_delta',
      'usage',
      'turn_end',
    ]);
  });

  test('provider 抛错 → error 信封，TurnResult 终止为 error', async () => {
    // 用不可重试的 not_found 保证单次请求即失败（可重试错误会先退避重试，
    // 其行为由 retry.test.ts 覆盖，此处聚焦信封序列）。
    const notFound = new ProviderError({
      kind: 'not_found',
      message: '模型不存在',
    });
    const stub = new StubProvider([{ throw: notFound }]);
    const { envelopes, result } = await runTurnWithProtocol({
      provider: stub,
      messages: [userMsg],
      options: { maxTurns: 5 },
    });

    expect(result.termination).toBe('error');
    expect(result.error).toBe(notFound);
    expect(envelopes.map((e) => e.type)).toEqual([
      'turn_start',
      'error',
      'turn_end',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 协议演进约束（3.x 节的「只加字段，不做破坏性修改」）
// ---------------------------------------------------------------------------

describe('协议演进约束', () => {
  // 与 3.2 表逐项对齐；新增事件类型必须显式加进这个清单
  const EVENT_TYPES: readonly EventType[] = [
    'turn_start',
    'turn_end',
    'text_delta',
    'thinking_delta',
    'tool_call',
    'tool_progress',
    'tool_result',
    'approval_request',
    'approval_resolved',
    'usage',
    'context_state',
    'compaction',
    'notice',
    'error',
  ];

  test('EventType 全集与 3.2 表一致（无增删）', () => {
    const expected: readonly EventType[] = [
      'approval_request',
      'approval_resolved',
      'compaction',
      'context_state',
      'error',
      'notice',
      'text_delta',
      'thinking_delta',
      'tool_call',
      'tool_progress',
      'tool_result',
      'turn_end',
      'turn_start',
      'usage',
    ];
    expect([...EVENT_TYPES].sort()).toEqual([...expected].sort());
  });

  test('信封字段固定为 v/seq/ts/agent/turn/type/data（新增字段须可选）', () => {
    const emitter = new EnvelopeEmitter({ now: () => 1 });
    const envelope = emitter.emit({
      type: 'notice',
      data: { level: 'info', text: 'hi' },
    });
    expect(Object.keys(envelope).sort()).toEqual([
      'agent',
      'data',
      'seq',
      'ts',
      'turn',
      'type',
      'v',
    ]);
  });

  // 类型层面：ProtocolEvent 是判别联合，新增事件类型不改既有消费者
  // （见 events.ts 顶部注释）；这里用一个不含任何未知类型的样本集验证可序列化。
  test('每个事件类型的负载均可 JSON 序列化且无 undefined/函数字段', () => {
    const samples: ProtocolEvent[] = [
      { type: 'turn_start', data: { turn: 1 } },
      { type: 'turn_end', data: { turn: 1, termination: 'interrupted' } },
      { type: 'text_delta', data: { delta: '你' } },
      { type: 'thinking_delta', data: { delta: '思考' } },
      {
        type: 'tool_call',
        data: { id: 'call-1', name: 'bash', input: { cmd: 'ls' } },
      },
      { type: 'tool_progress', data: { id: 'call-1', text: 'running…' } },
      { type: 'tool_result', data: { id: 'call-1', ok: true, summary: 'ok' } },
      {
        type: 'approval_request',
        data: {
          id: 'req-1',
          description: '执行 rm -rf dist',
          risk: 'exec',
          options: [
            { id: 'allow_once', label: '允许本次' },
            { id: 'deny', label: '拒绝' },
          ],
        },
      },
      {
        type: 'approval_resolved',
        data: { id: 'req-1', decision: 'allow_once', source: 'user' },
      },
      { type: 'usage', data: { inputTokens: 10, outputTokens: 5 } },
      {
        type: 'context_state',
        data: {
          nearCompaction: false,
          sections: [{ name: 'tools', tokens: 100 }],
        },
      },
      {
        type: 'compaction',
        data: { beforeTokens: 100, afterTokens: 50, coveredTurns: [1, 3] },
      },
      { type: 'notice', data: { level: 'info', text: 'hi' } },
      {
        type: 'error',
        data: {
          category: 'provider',
          kind: 'rate_limited',
          recoverable: true,
          message: '限流',
        },
      },
    ];

    for (const event of samples) {
      const text = JSON.stringify(event);
      expect(text).toBeTypeOf('string');
      const parsed = JSON.parse(text) as ProtocolEvent;
      expect(parsed.type).toBe(event.type);
      // 负载经序列化往返后不含 undefined 字段
      const undefinedValues = Object.values(parsed.data).filter(
        (value) => value === undefined,
      );
      expect(undefinedValues).toHaveLength(0);
    }
  });
});
