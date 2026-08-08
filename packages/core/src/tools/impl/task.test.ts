import { describe, expect, test } from 'bun:test';
import type { ModelMessage, ToolSet } from 'ai';
import type { ProviderCapabilities } from '../../provider/capabilities';
import { ProviderError } from '../../provider/errors';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
  TokenUsage,
} from '../../provider/types';
import { runToolPipeline } from '../pipeline';
import { ToolRegistry } from '../registry';
import {
  createSubagentRunner,
  SUBAGENT_DEPTH_LIMIT,
} from '../../runtime/subagent';
import { runAgentTurn } from '../../runtime/loop';
import { createTaskTool, TASK_TOOL_NAME } from './task';
import { readTool } from './read';
import { grepTool } from './grep';

// ---------------------------------------------------------------------------
// 测试替身：StubProvider —— 完全本地、不访问外网的假 ModelProvider。
// 主代理与子代理共用同一实例（派生子代理 = 同 provider 再跑一次 runAgentTurn），
// 轮次按调用顺序消费；用尽后重放最后一轮。
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

/** 快照消息数组（浅复制 message/part）：loop 会在请求后原地 mutate thread，防止 seenMessages 记录被后续轮次污染。 */
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
  /** 每次 streamChat 收到的消息序列（断言主/子代理各自的消息历史）。 */
  readonly seenMessages: ModelMessage[][] = [];
  /** 每次 streamChat 收到的 tools（断言白名单派生）。 */
  readonly seenTools: Array<ToolSet | undefined> = [];
  /** 同时活跃的流数（断言并发用；T-123）。 */
  activeStreams = 0;
  maxActiveStreams = 0;
  private callCount = 0;

  constructor(private readonly rounds: StubRound[]) {}

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    this.seenMessages.push(snapshotMessages(input.messages));
    this.seenTools.push(input.tools);
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

// ---------------------------------------------------------------------------
// 事件序列构造
// ---------------------------------------------------------------------------

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

const userMsg: ModelMessage = {
  role: 'user',
  content: '把这个仓库里的硬编码超时都找出来',
};

/** 主代理工具集：read / grep / task（子代理白名单从这里派生）。 */
function parentRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readTool)
    .register(grepTool)
    .register(createTaskTool());
}

/** 从一条 ModelMessage 里取 role === 'tool' 消息的第一个 tool-result 输出。 */
function toolResultOutput(messages: readonly ModelMessage[]): unknown {
  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.content === 'string')
      continue;
    for (const part of message.content) {
      if (part.type === 'tool-result') return part.output;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('Task 工具（T-120 子代理）', () => {
  test('子代理执行并返回结论：主代理只拿到最终结论文本', async () => {
    const conclusion =
      '结论：仓库里有 3 处硬编码超时——src/a.ts:10（3000ms）、src/b.ts:22（5000ms）、src/c.ts:7（1000ms）。建议统一抽成常量。';
    const stub = new StubProvider([
      taskUseEvents('找出所有硬编码超时配置'),
      textEvents(conclusion),
      textEvents('已收到子代理结论，我将汇总给用户。'),
    ]);

    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        tools: parentRegistry(),
        options: { maxTurns: 5 },
      },
      () => {},
    );

    expect(result.termination).toBe('end_turn');
    // result.turns 只数主代理自己的请求（2 轮）；子代理的请求独立核算、
    // 不计入主代理轮次（独立上下文窗口的体现）
    expect(result.turns).toBe(2); // 主 round1（派发）→ 主 round2（收尾）

    // 子代理的结论回喂主代理（tool-result 的 forModel 文本）
    expect(result.text).toBe('已收到子代理结论，我将汇总给用户。');
    const secondRequest = stub.seenMessages[2];
    expect(toolResultOutput(secondRequest)).toEqual(
      expect.objectContaining({
        type: 'text',
        value: expect.stringContaining(conclusion),
      }),
    );
  });

  test('子代理有独立消息历史：不携带主代理历史，主代理历史也不被子代理污染', async () => {
    const stub = new StubProvider([
      taskUseEvents('找出所有硬编码超时配置'),
      textEvents('结论：src/a.ts:10。'),
      textEvents('已汇总。'),
    ]);

    await runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        tools: parentRegistry(),
        options: { maxTurns: 5 },
      },
      () => {},
    );

    // 主代理第一次请求 = 只有自己的 user 消息
    expect(stub.seenMessages[0]).toEqual([userMsg]);
    // 子代理第一次请求 = 只有 request.prompt（独立历史，不携带主代理历史）
    expect(stub.seenMessages[1]).toEqual([
      { role: 'user', content: '找出所有硬编码超时配置' },
    ]);
    // 主代理第二次请求 = 自己的历史 + task 工具结果，没有子代理的中间过程
    expect(stub.seenMessages[2]).toHaveLength(3);
    expect(stub.seenMessages[2][0]).toEqual(userMsg);
    // 子代理的默认工具白名单 = 只读三件套（父代理注册表派生）
    const subagentTools = stub.seenTools[1];
    expect(subagentTools).toBeDefined();
    if (subagentTools !== undefined) {
      expect(Object.keys(subagentTools).sort()).toEqual(['grep', 'read']);
    }
  });

  test('一层深限制：子代理注册表不含 task 工具（派发经白名单被剔除）', async () => {
    const stub = new StubProvider([
      taskUseEvents('子任务 A'),
      // 子代理试图再派生子代理：task 工具不在其注册表 → 未知工具拒绝
      taskUseEvents('子任务 B', 'call-nested'),
      textEvents('我无法再派生子代理，任务无法完成。'),
      textEvents('收到。'),
    ]);

    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        tools: parentRegistry(),
        options: { maxTurns: 6 },
      },
      () => {},
    );

    expect(result.termination).toBe('end_turn');
    // 子代理第二次请求（stub.seenMessages[2]）里的 task 调用被拒绝：
    // 拒绝消息 = 未知工具（task 未进入子代理注册表，白名单过滤）
    const nested = toolResultOutput(stub.seenMessages[2]);
    expect(nested).toEqual(
      expect.objectContaining({
        type: 'error-text',
        value: expect.stringContaining('未知工具 "task"'),
      }),
    );
  });

  test('一层深限制：派发器 depth ≥ 1 时直接拒绝（代码 assert，不靠约定）', async () => {
    const runner = createSubagentRunner({
      // 不应真正触发——depth 检查在进入 runTurn 之前
      runTurn: () => {
        throw new Error('不应调用 runTurn');
      },
      provider: new StubProvider([]),
      parentRegistry: parentRegistry(),
      readFiles: new Set<string>(),
      cwd: process.cwd(),
      depth: SUBAGENT_DEPTH_LIMIT,
    });

    const result = await runner({ prompt: '再派一个子代理' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('一层深');
    expect(result.agentId).toBeUndefined();
  });

  test('未注入 runSubagent 时 Task 工具返回「不可用」失败结果（错误即数据）', async () => {
    const outcome = await runToolPipeline(
      { id: 'call-1', name: TASK_TOOL_NAME, input: { prompt: '调研' } },
      { registry: parentRegistry() },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('runSubagent');
  });

  test('参数校验：prompt 必填、tools/maxTurns/maxTokens 类型约束', async () => {
    const registry = parentRegistry();
    const missingPrompt = await runToolPipeline(
      { id: 'call-1', name: TASK_TOOL_NAME, input: {} },
      { registry },
    );
    expect(missingPrompt.ok).toBe(false);
    expect(missingPrompt.forModel).toContain('prompt');

    const badMaxTurns = await runToolPipeline(
      {
        id: 'call-2',
        name: TASK_TOOL_NAME,
        input: { prompt: 'x', maxTurns: -1 },
      },
      { registry },
    );
    expect(badMaxTurns.ok).toBe(false);
    expect(badMaxTurns.forModel).toContain('maxTurns');
  });
});
