import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import type { ProviderCapabilities } from '../provider/capabilities';
import { ProviderError } from '../provider/errors';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
} from '../provider/types';
import { runTurnWithProtocol } from '../protocol/bridge';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import type { WriteConflictReport } from '../tools/types';
import { WriteConflictDetector } from '../tools/write-conflict';
import { runAgentTurn } from './loop';
import { createTaskTool, TASK_TOOL_NAME } from '../tools/impl/task';
import { readTool } from '../tools/impl/read';

// ---------------------------------------------------------------------------
// 测试替身（T-123 并发执行 + 写冲突检测）
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

/** 快照消息数组（防 loop 原地 mutate 污染记录）。 */
function snapshotMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { ...m } as ModelMessage;
    return { ...m, content: m.content.map((p) => ({ ...p })) } as ModelMessage;
  });
}

class StubProvider implements ModelProvider {
  readonly id = 'stub';
  readonly modelId = 'stub-model';
  readonly capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES;
  readonly seenMessages: ModelMessage[][] = [];
  /** 同时活跃的流数（断言并发派发用）。 */
  activeStreams = 0;
  maxActiveStreams = 0;
  private callCount = 0;

  constructor(private readonly rounds: StubRound[]) {}

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    this.seenMessages.push(snapshotMessages(input.messages));
    this.activeStreams += 1;
    this.maxActiveStreams = Math.max(this.maxActiveStreams, this.activeStreams);
    try {
      const round =
        this.rounds[Math.min(this.callCount, this.rounds.length - 1)];
      this.callCount += 1;
      if ('throw' in round) throw round.throw;
      for (const event of round) {
        if (input.abortSignal?.aborted) {
          throw new ProviderError({ kind: 'aborted', message: '请求已被中断' });
        }
        yield event;
      }
    } finally {
      this.activeStreams -= 1;
    }
  }
}

function textEvents(text: string): StreamEvent[] {
  const events: StreamEvent[] = Array.from(text).map((char) => ({
    type: 'text_delta',
    delta: char,
  }));
  events.push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } });
  events.push({ type: 'finish', reason: 'stop' });
  return events;
}

function toolUseEvents(
  name: string,
  input: unknown,
  id = 'call-x',
): StreamEvent[] {
  return [
    { type: 'tool_use', id, name, input },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: 'tool_use' },
  ];
}

function taskUseEvents(
  prompt: string,
  id = 'call-task',
  extra: Record<string, unknown> = {},
): StreamEvent[] {
  return [
    {
      type: 'tool_use',
      id,
      name: TASK_TOOL_NAME,
      input: { prompt, ...extra },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: 'tool_use' },
  ];
}

const userMsg: ModelMessage = { role: 'user', content: '开始' };

/** 假写工具（risk: write，不触碰文件系统；成功即自报 onFileWrite 供冲突检测）。 */
function createFakeWriteTool(counters: {
  activeExecs: number;
  maxExecs: number;
}): Tool {
  return {
    name: 'fakewrite',
    description: '假写工具（测试用）',
    risk: 'write',
    schema: z.object({ path: z.string() }),
    execute: async (
      args: { path: string },
      ctx: { onFileWrite?: (path: string) => void },
    ) => {
      counters.activeExecs += 1;
      counters.maxExecs = Math.max(counters.maxExecs, counters.activeExecs);
      try {
        ctx.onFileWrite?.(args.path);
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { ok: true, forModel: `已写入 ${args.path}` };
      } finally {
        counters.activeExecs -= 1;
      }
    },
  };
}

/** 主代理工具集：read + fakewrite + task。 */
function parentRegistry(fakeWrite: Tool): ToolRegistry {
  return new ToolRegistry()
    .register(readTool)
    .register(fakeWrite)
    .register(createTaskTool());
}

/** 收集一条消息里全部 tool-result 的 forModel 文本（任务结论聚合断言用）。 */
function toolResultTexts(messages: readonly ModelMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.content === 'string')
      continue;
    for (const part of message.content) {
      if (part.type === 'tool-result') {
        const value = (part.output as { value?: unknown }).value;
        if (typeof value === 'string') texts.push(value);
      }
    }
  }
  return texts;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('并发执行（T-123）', () => {
  test('同一轮多个 task 并行派发：两子代理同时运行、结论按调用顺序聚合', async () => {
    const counters = { activeExecs: 0, maxExecs: 0 };
    const fakeWrite = createFakeWriteTool(counters);
    const stub = new StubProvider([
      [
        {
          type: 'tool_use' as const,
          id: 'call-task-a',
          name: TASK_TOOL_NAME,
          input: { prompt: '任务 A：找出配置 A' },
        },
        {
          type: 'tool_use' as const,
          id: 'call-task-b',
          name: TASK_TOOL_NAME,
          input: { prompt: '任务 B：找出配置 B' },
        },
        { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 3 } },
        { type: 'finish' as const, reason: 'tool_use' as const },
      ],
      textEvents('结论A：src/a.ts:1'),
      textEvents('结论B：src/b.ts:2'),
      textEvents('已汇总两个结论。'),
    ]);

    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        tools: parentRegistry(fakeWrite),
        options: { maxTurns: 6 },
      },
      () => {},
    );

    expect(result.termination).toBe('end_turn');
    // 并发：两个子代理的 provider 流同时活跃（maxActiveStreams >= 2，
    // 若串行则恒为 1）
    expect(stub.maxActiveStreams).toBeGreaterThanOrEqual(2);

    // 主代理第二轮同时拿到两个子代理的结论（结果按调用顺序聚合）
    // 调用序：主1 → 子A1 → 子B1 → 主2（两个子代理都是单轮文本即结束）
    const texts = toolResultTexts(stub.seenMessages[3]);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('结论A');
    expect(texts[1]).toContain('结论B');
  });

  test('非 concurrent 工具同一轮多次调用仍串行执行（002 十一默认行为）', async () => {
    const counters = { activeExecs: 0, maxExecs: 0 };
    const slowTool: Tool = {
      name: 'slow',
      description: '慢工具（测试用）',
      risk: 'read',
      schema: z.object({}),
      execute: async () => {
        counters.activeExecs += 1;
        counters.maxExecs = Math.max(counters.maxExecs, counters.activeExecs);
        try {
          await new Promise((resolve) => setTimeout(resolve, 3));
          return { ok: true, forModel: 'slow 完成' };
        } finally {
          counters.activeExecs -= 1;
        }
      },
    };
    const stub = new StubProvider([
      [
        { type: 'tool_use' as const, id: 'c1', name: 'slow', input: {} },
        { type: 'tool_use' as const, id: 'c2', name: 'slow', input: {} },
        { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 3 } },
        { type: 'finish' as const, reason: 'tool_use' as const },
      ],
      textEvents('完成'),
    ]);

    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        tools: new ToolRegistry().register(slowTool),
        options: { maxTurns: 5 },
      },
      () => {},
    );

    expect(result.termination).toBe('end_turn');
    expect(result.turns).toBe(2);
    // 串行：两次 slow 执行从不重叠
    expect(counters.maxExecs).toBe(1);
    expect(stub.maxActiveStreams).toBe(1);
  });
});

describe('写冲突检测（T-123，ADR 0011）', () => {
  test('主代理先写、子代理再写同一文件 → 检出冲突并发出 notice', async () => {
    const counters = { activeExecs: 0, maxExecs: 0 };
    const fakeWrite = createFakeWriteTool(counters);
    const detector = new WriteConflictDetector();
    const conflicts: WriteConflictReport[] = [];
    const onFileWrite = (path: string, agent: string) => {
      const report = detector.recordWrite(path, agent);
      if (report !== undefined) conflicts.push(report);
      return report;
    };

    const stub = new StubProvider([
      toolUseEvents(
        'fakewrite',
        { path: '/tmp/shared.txt' },
        'call-main-write',
      ),
      taskUseEvents('写共享文件', 'call-task', { tools: ['fakewrite'] }),
      toolUseEvents('fakewrite', { path: '/tmp/shared.txt' }, 'call-sub-write'),
      textEvents('已写入共享文件。'),
      textEvents('汇总完成。'),
    ]);

    const { envelopes, result } = await runTurnWithProtocol({
      provider: stub,
      messages: [userMsg],
      tools: parentRegistry(fakeWrite),
      onFileWrite,
      options: { maxTurns: 8 },
    });

    expect(result.termination).toBe('end_turn');
    // 冲突报告：子代理写入时发现主代理已写过同一文件
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].path).toBe('/tmp/shared.txt');
    expect(conflicts[0].agent.startsWith('sub-')).toBe(true);
    expect(conflicts[0].existingAgent).toBe('main');
    // 检测器按文件只保留最新写入（同路径被覆盖）：latest = 子代理的写入
    expect(detector.allWrites()).toHaveLength(1);
    expect(detector.allWrites()[0].agent.startsWith('sub-')).toBe(true);

    // 冲突经 notice（warn）告知前端（子代理 agent 信封，可折叠展示）
    const conflictNotice = envelopes.find(
      (e) => e.type === 'notice' && e.agent !== 'main',
    );
    expect(conflictNotice).toBeDefined();
    if (conflictNotice?.type === 'notice') {
      expect(conflictNotice.data.text).toContain('写冲突');
      expect(conflictNotice.data.text).toContain('/tmp/shared.txt');
      expect(conflictNotice.data.text).toContain('main');
    }
  });

  test('两个并行子代理写同一文件 → 检出跨子代理冲突', async () => {
    const counters = { activeExecs: 0, maxExecs: 0 };
    const fakeWrite = createFakeWriteTool(counters);
    const detector = new WriteConflictDetector();
    const conflicts: WriteConflictReport[] = [];
    const onFileWrite = (path: string, agent: string) => {
      const report = detector.recordWrite(path, agent);
      if (report !== undefined) conflicts.push(report);
      return report;
    };

    const stub = new StubProvider([
      [
        {
          type: 'tool_use' as const,
          id: 'call-a',
          name: TASK_TOOL_NAME,
          input: { prompt: 'A', tools: ['fakewrite'] },
        },
        {
          type: 'tool_use' as const,
          id: 'call-b',
          name: TASK_TOOL_NAME,
          input: { prompt: 'B', tools: ['fakewrite'] },
        },
        { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 3 } },
        { type: 'finish' as const, reason: 'tool_use' as const },
      ],
      toolUseEvents('fakewrite', { path: '/tmp/shared.txt' }, 'call-a-write'),
      toolUseEvents('fakewrite', { path: '/tmp/shared.txt' }, 'call-b-write'),
      textEvents('A 完成'),
      textEvents('B 完成'),
      textEvents('汇总完成。'),
    ]);

    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        tools: parentRegistry(fakeWrite),
        onFileWrite,
        options: { maxTurns: 8 },
      },
      () => {},
    );

    expect(result.termination).toBe('end_turn');
    // 两个子代理写同一文件：后写者检出与先写者的冲突
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    const report = conflicts[0];
    expect(report.path).toBe('/tmp/shared.txt');
    expect(report.agent.startsWith('sub-')).toBe(true);
    expect(report.existingAgent.startsWith('sub-')).toBe(true);
    expect(report.existingAgent).not.toBe(report.agent);
  });

  test('同一 agent 连续写同一文件不误报冲突', () => {
    const detector = new WriteConflictDetector();
    expect(detector.recordWrite('/a.ts', 'main')).toBeUndefined();
    expect(detector.recordWrite('/a.ts', 'main')).toBeUndefined();
    expect(detector.size).toBe(1);
    const subWrite = detector.recordWrite('/a.ts', 'sub-x');
    expect(subWrite).toBeDefined();
    if (subWrite !== undefined) {
      expect(subWrite.existingAgent).toBe('main');
      expect(subWrite.agent).toBe('sub-x');
    }
  });
});
