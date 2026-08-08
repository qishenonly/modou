import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { ApprovalGate } from '../permission/approval';
import type { ProviderCapabilities } from '../provider/capabilities';
import { ProviderError } from '../provider/errors';
import type { ModelProvider, StreamEvent } from '../provider/types';
import { createTaskTool } from '../tools/impl/task';
import { readTool } from '../tools/impl/read';
import { ToolRegistry } from '../tools/registry';
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

  test('tool_result → 协议 tool_result（id/ok/summary/forModel/payload）', () => {
    expect(
      mapRuntimeEvent({
        type: 'tool_result',
        id: 'call-1',
        ok: true,
        summary: '第一行',
        forModel: '第一行\n第二行',
        payload: { path: '/repo/src/a.ts' },
      }),
    ).toEqual([
      {
        type: 'tool_result',
        data: {
          id: 'call-1',
          ok: true,
          summary: '第一行',
          forModel: '第一行\n第二行',
          payload: { path: '/repo/src/a.ts' },
        },
      },
    ]);

    // 可选字段（forModel / payload）缺省时不出现
    expect(
      mapRuntimeEvent({
        type: 'tool_result',
        id: 'call-2',
        ok: false,
        summary: '失败',
      }),
    ).toEqual([
      {
        type: 'tool_result',
        data: { id: 'call-2', ok: false, summary: '失败' },
      },
    ]);
  });

  test('approval_request / approval_resolved → 协议事件（T-033）', () => {
    expect(
      mapRuntimeEvent({
        type: 'approval_request',
        id: 'req-1',
        description: '执行命令：npm run test',
        risk: 'exec',
        options: [
          { id: 'allow_once', label: '允许本次' },
          { id: 'deny', label: '拒绝' },
        ],
      }),
    ).toEqual([
      {
        type: 'approval_request',
        data: {
          id: 'req-1',
          description: '执行命令：npm run test',
          risk: 'exec',
          options: [
            { id: 'allow_once', label: '允许本次' },
            { id: 'deny', label: '拒绝' },
          ],
        },
      },
    ]);
    expect(
      mapRuntimeEvent({
        type: 'approval_resolved',
        id: 'req-1',
        decision: 'allow_once',
        source: 'user',
      }),
    ).toEqual([
      {
        type: 'approval_resolved',
        data: { id: 'req-1', decision: 'allow_once', source: 'user' },
      },
    ]);
  });

  test('context_state → 协议 context_state（分项 + 合计 + drift，T-063）', () => {
    expect(
      mapRuntimeEvent({
        type: 'context_state',
        data: {
          nearCompaction: false,
          sections: [
            { name: 'system', tokens: 100 },
            { name: 'tools', tokens: 200 },
            { name: 'history', tokens: 300 },
          ],
          total: 600,
          drift: { estimated: 700, actual: 600, error: 100, rate: 100 / 600 },
        },
      }),
    ).toEqual([
      {
        type: 'context_state',
        data: {
          nearCompaction: false,
          sections: [
            { name: 'system', tokens: 100 },
            { name: 'tools', tokens: 200 },
            { name: 'history', tokens: 300 },
          ],
          total: 600,
          drift: { estimated: 700, actual: 600, error: 100, rate: 100 / 600 },
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
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(envelopes.map((e) => e.type)).toEqual([
      'turn_start',
      'text_delta',
      'text_delta',
      'usage',
      'context_state',
      'turn_end',
    ]);
    expect(envelopes.map((e) => e.turn)).toEqual([1, 1, 1, 1, 1, 1]);
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
      'context_state',
      'turn_end',
    ]);
  });

  test('注册工具执行：tool_call + tool_result 信封，第二轮正常收尾', async () => {
    const registry = new ToolRegistry().register({
      name: 'echo',
      description: '回显（测试用）',
      risk: 'read',
      schema: z.object({ text: z.string().min(1) }),
      execute: async (args: { text: string }) => ({
        ok: true,
        forModel: `echo:${args.text}`,
      }),
    });
    const stub = new StubProvider([
      [
        {
          type: 'tool_use' as const,
          id: 'call-1',
          name: 'echo',
          input: { text: '你好' },
        },
        { type: 'usage' as const, usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish' as const, reason: 'tool_use' as const },
      ],
      textRound('好的'),
    ]);
    const { envelopes, result } = await runTurnWithProtocol({
      provider: stub,
      messages: [userMsg],
      tools: registry,
      options: { maxTurns: 5 },
    });

    expect(result.termination).toBe('end_turn');
    expect(result.turns).toBe(2);

    // 流式 tool_use → tool_call 信封；管线结果 → tool_result 信封
    const toolCall = envelopes.find((e) => e.type === 'tool_call');
    expect(toolCall).toBeDefined();
    if (toolCall?.type === 'tool_call') {
      expect(toolCall.data).toEqual({
        id: 'call-1',
        name: 'echo',
        input: { text: '你好' },
      });
    }
    const toolResult = envelopes.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.data).toEqual({
        id: 'call-1',
        ok: true,
        summary: 'echo:你好',
        forModel: 'echo:你好',
      });
    }
    // 已注册工具不产生未知工具 notice
    expect(envelopes.some((e) => e.type === 'notice')).toBe(false);

    // 跨轮次信封：turn 1 含 tool_call + tool_result；turn 2 收尾
    expect(envelopes.filter((e) => e.turn === 1).map((e) => e.type)).toEqual([
      'turn_start',
      'tool_call',
      'usage',
      'tool_result',
    ]);
  });

  test('write 工具经审批闸门放行：approval_request/resolved 信封配对，工具执行', async () => {
    const registry = new ToolRegistry().register({
      name: 'write-stub',
      description: '写入（测试用）',
      risk: 'write',
      schema: z.object({ path: z.string() }),
      execute: async () => ({ ok: true, forModel: '已写入（stub）' }),
    });
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'allow_once', source: 'user' }),
    });
    const stub = new StubProvider([
      [
        {
          type: 'tool_use' as const,
          id: 'call-1',
          name: 'write-stub',
          input: { path: '/a.ts' },
        },
        { type: 'usage' as const, usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish' as const, reason: 'tool_use' as const },
      ],
      textRound('好的'),
    ]);
    const { envelopes, result } = await runTurnWithProtocol({
      provider: stub,
      messages: [userMsg],
      tools: registry,
      approval: gate,
      options: { maxTurns: 5 },
    });

    expect(result.termination).toBe('end_turn');
    expect(result.turns).toBe(2);

    const request = envelopes.find((e) => e.type === 'approval_request');
    const resolved = envelopes.find((e) => e.type === 'approval_resolved');
    expect(request).toBeDefined();
    expect(resolved).toBeDefined();
    if (
      request?.type === 'approval_request' &&
      resolved?.type === 'approval_resolved'
    ) {
      // 配对：同一请求 id
      expect(resolved.data.id).toBe(request.data.id);
      expect(request.data.risk).toBe('write');
      expect(request.data.description).toContain('/a.ts');
      expect(resolved.data.decision).toBe('allow_once');
    }
    const toolResult = envelopes.find(
      (e) => e.type === 'tool_result' && e.data.id === 'call-1',
    );
    expect(toolResult?.type).toBe('tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.data.ok).toBe(true);
    }
  });

  test('write 工具被闸门拒绝：策略性拒绝回喂，工具不执行', async () => {
    const registry = new ToolRegistry().register({
      name: 'write-stub',
      description: '写入（测试用）',
      risk: 'write',
      schema: z.object({ path: z.string() }),
      execute: async () => ({ ok: true, forModel: '不应执行' }),
    });
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'deny', source: 'user' }),
    });
    const stub = new StubProvider([
      [
        {
          type: 'tool_use' as const,
          id: 'call-1',
          name: 'write-stub',
          input: { path: '/a.ts' },
        },
        { type: 'usage' as const, usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish' as const, reason: 'tool_use' as const },
      ],
      textRound('好的'),
    ]);
    const { envelopes } = await runTurnWithProtocol({
      provider: stub,
      messages: [userMsg],
      tools: registry,
      approval: gate,
      options: { maxTurns: 5 },
    });

    const toolResult = envelopes.find(
      (e) => e.type === 'tool_result' && e.data.id === 'call-1',
    );
    expect(toolResult?.type).toBe('tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.data.ok).toBe(false);
      expect(toolResult.data.forModel).toContain('被拒绝');
    }
    // 事件配对顺序：approval_request → approval_resolved → tool_result(ok:false)
    const requestIdx = envelopes.findIndex(
      (e) => e.type === 'approval_request',
    );
    const resolvedIdx = envelopes.findIndex(
      (e) => e.type === 'approval_resolved',
    );
    const resultIdx = envelopes.findIndex(
      (e) => e.type === 'tool_result' && e.data.id === 'call-1',
    );
    expect(requestIdx).toBeGreaterThan(-1);
    expect(resolvedIdx).toBeGreaterThan(requestIdx);
    expect(resultIdx).toBeGreaterThan(resolvedIdx);
  });

  test('tool_use 入参含密钥：协议 tool_call 信封里被脱敏', async () => {
    const registry = new ToolRegistry().register({
      name: 'echo',
      description: '回显（测试用）',
      risk: 'read',
      schema: z.object({ text: z.string() }),
      execute: async (args: { text: string }) => ({
        ok: true,
        forModel: args.text,
      }),
    });
    const stub = new StubProvider([
      [
        {
          type: 'tool_use' as const,
          id: 'call-1',
          name: 'echo',
          input: { token: 'sk-abcdefghijklmnopqrstuvwxyz' },
        },
        { type: 'usage' as const, usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish' as const, reason: 'tool_use' as const },
      ],
      textRound('好的'),
    ]);
    const { envelopes, result } = await runTurnWithProtocol({
      provider: stub,
      messages: [userMsg],
      tools: registry,
      options: { maxTurns: 5 },
    });

    expect(result.termination).toBe('end_turn');
    expect(result.turns).toBe(2);

    // 流式 tool_use → tool_call 信封：入参先经 redactValue（与管线 Record 语义一致）
    const toolCall = envelopes.find((e) => e.type === 'tool_call');
    expect(toolCall).toBeDefined();
    if (toolCall?.type === 'tool_call') {
      expect(toolCall.data.input).toEqual({ token: 'sk-[REDACTED]' });
    }
    expect(JSON.stringify(envelopes)).not.toContain(
      'sk-abcdefghijklmnopqrstuvwxyz',
    );
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
      'context_state',
      'turn_end',
    ]);
  });

  test('子代理事件带 agent 字段（T-122）：主/子信封可区分，子代理独立 seq 空间', async () => {
    const registry = new ToolRegistry()
      .register(readTool)
      .register(createTaskTool());
    const stub = new StubProvider([
      [
        {
          type: 'tool_use' as const,
          id: 'call-task',
          name: 'task',
          input: { prompt: '找硬编码超时', tools: ['read'] },
        },
        { type: 'usage' as const, usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish' as const, reason: 'tool_use' as const },
      ],
      textRound('结论：src/a.ts:10。'),
      textRound('已汇总。'),
    ]);
    const { envelopes, result } = await runTurnWithProtocol({
      provider: stub,
      messages: [userMsg],
      tools: registry,
      options: { maxTurns: 5 },
    });

    expect(result.termination).toBe('end_turn');

    const mainEvents = envelopes.filter((e) => e.agent === 'main');
    const subEvents = envelopes.filter((e) => e.agent !== 'main');
    expect(mainEvents.length).toBeGreaterThan(0);
    expect(subEvents.length).toBeGreaterThan(0);

    // 子代理 agent 是 sub- 前缀 ID（bridge 为每个子代理建独立信封发射器）
    const subAgents = new Set(subEvents.map((e) => e.agent));
    expect([...subAgents].every((a) => a.startsWith('sub-'))).toBe(true);

    // 子代理的 text_delta 是结论文本，且独立于主代理（seq 从 1 开始）
    const subTurnStart = subEvents.find((e) => e.type === 'turn_start');
    expect(subTurnStart).toBeDefined();
    if (subTurnStart !== undefined) {
      expect(subTurnStart.seq).toBe(1);
    }
    const subText = subEvents.find((e) => e.type === 'text_delta');
    expect(subText).toBeDefined();
    if (subText?.type === 'text_delta') {
      expect(subText.data.delta).toBe('结');
    }

    // 主代理 text_delta 只有自己的收尾文本（子代理过程不污染主对话）
    const mainTexts = mainEvents
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.data.delta : ''));
    expect(mainTexts.join('')).toBe('已汇总。');
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
          total: 100,
          drift: { estimated: 120, actual: 100, error: 20, rate: 0.2 },
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
