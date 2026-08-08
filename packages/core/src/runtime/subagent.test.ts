import { describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage, ToolSet } from 'ai';
import { z } from 'zod';
import type { ProviderCapabilities } from '../provider/capabilities';
import { ProviderError } from '../provider/errors';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
} from '../provider/types';
import { ApprovalGate } from '../permission/approval';
import { runToolPipeline } from '../tools/pipeline';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import { runAgentTurn } from './loop';
import { createTaskTool, TASK_TOOL_NAME } from '../tools/impl/task';
import { readTool } from '../tools/impl/read';
import { writeTool } from '../tools/impl/write';
import { grepTool } from '../tools/impl/grep';
import { createSubagentRunner, deriveSubagentRegistry } from './subagent';

// ---------------------------------------------------------------------------
// 测试替身（T-121 子代理隔离）
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

type StubRound =
  StreamEvent[] | { readonly throw: unknown } | { readonly hang: true };

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
  readonly seenTools: Array<ToolSet | undefined> = [];
  private callCount = 0;

  constructor(private readonly rounds: StubRound[]) {}

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    this.seenMessages.push(snapshotMessages(input.messages));
    this.seenTools.push(input.tools);
    const round = this.rounds[Math.min(this.callCount, this.rounds.length - 1)];
    this.callCount += 1;
    if ('throw' in round) throw round.throw;
    if ('hang' in round) {
      // 挂起直到 abort：超时测试用（T-121 timeoutMs）
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          reject(
            new ProviderError({ kind: 'aborted', message: '请求已被中断' }),
          );
        };
        if (input.abortSignal?.aborted) {
          onAbort();
          return;
        }
        input.abortSignal?.addEventListener('abort', onAbort, { once: true });
      });
      return;
    }
    for (const event of round) {
      if (input.abortSignal?.aborted) {
        throw new ProviderError({ kind: 'aborted', message: '请求已被中断' });
      }
      yield event;
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
  extra: Record<string, unknown> = {},
): StreamEvent[] {
  return [
    {
      type: 'tool_use',
      id: 'call-task',
      name: TASK_TOOL_NAME,
      input: { prompt, ...extra },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: 'tool_use' },
  ];
}

const userMsg: ModelMessage = { role: 'user', content: '开始' };

/** 无副作用测试工具（risk: read）。 */
const noopTool: Tool = {
  name: 'noop',
  description: 'no-op（测试用）',
  risk: 'read',
  schema: z.object({}),
  execute: async () => ({ ok: true, forModel: 'noop 完成' }),
};

/** 假写工具（risk: write，不触碰文件系统；权限裁决走同一条路径）。 */
const fakeWriteTool: Tool = {
  name: 'fakewrite',
  description: '假写工具（测试用）',
  risk: 'write',
  schema: z.object({ path: z.string() }),
  execute: async () => ({ ok: true, forModel: '已写入（测试替身）' }),
};

/** 主代理工具集：read / grep / write / noop / fakewrite / task。 */
function parentRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readTool)
    .register(grepTool)
    .register(writeTool)
    .register(noopTool)
    .register(fakeWriteTool)
    .register(createTaskTool());
}

/** 从一条 ModelMessage 里取第一个 tool-result 输出。 */
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

describe('子代理隔离（T-121）', () => {
  test('白名单是父代理子集：父代理没有的工具名静默剔除（越权被拒）', () => {
    const parent = new ToolRegistry()
      .register(readTool)
      .register(grepTool)
      .register(writeTool);
    // 请求里带父代理没有的 "not-in-parent"：派生注册表不含它
    const derived = deriveSubagentRegistry(parent, [
      'write',
      'grep',
      'not-in-parent',
    ]);
    expect([...derived.names()].sort()).toEqual(['grep', 'write']);
    // task 工具永不进入子代理注册表（即使显式白名单放行）
    const withTask = new ToolRegistry()
      .register(readTool)
      .register(createTaskTool());
    expect(deriveSubagentRegistry(withTask, ['read', 'task']).names()).toEqual([
      'read',
    ]);
  });

  test('子代理无法调用未授权工具：白名单外的调用被「未知工具」拒绝', async () => {
    const stub = new StubProvider([
      taskUseEvents('研究仓库', { tools: ['grep'] }),
      toolUseEvents('write', { path: '/tmp/evil.txt', content: 'x' }),
      textEvents('我无法写入，只做研究。'),
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
    // 子代理白名单只有 grep：write 调用 → 未知工具拒绝（零副作用由白名单保证）
    const secondRequest = stub.seenMessages[2];
    expect(toolResultOutput(secondRequest)).toEqual(
      expect.objectContaining({
        type: 'error-text',
        value: expect.stringContaining('未知工具 "write"'),
      }),
    );
  });

  test('独立预算：父代理 maxTokens 不向下传导（子代理用完自己的轮次照常完成）', async () => {
    // 父代理 maxTokens=40：父代理自己的 2 轮用量 = 13 + 15 = 28，有富余；
    // 子代理 5 轮（4 次 noop 工具调用 + 1 轮文本）= 4×13 + 15 = 67，远超 40。
    // 若父预算泄漏到子代理，子代理会在第 4 轮后（52 > 40）被掐断；不泄漏则完整
    // 跑完 5 轮——用 seenMessages 长度区分（7 = 主 1 + 子 5 + 主 2）。
    const stub = new StubProvider([
      taskUseEvents('调研', { tools: ['noop'] }),
      toolUseEvents('noop', {}),
      toolUseEvents('noop', {}),
      toolUseEvents('noop', {}),
      toolUseEvents('noop', {}),
      textEvents('第五轮，完成'),
      textEvents('已汇总。'),
    ]);

    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        tools: parentRegistry(),
        options: { maxTurns: 8, maxTokens: 40 },
      },
      () => {},
    );

    expect(result.termination).toBe('end_turn');
    expect(result.text).toBe('已汇总。');
    // 子代理完整跑完 5 轮，未被父预算掐断（若泄漏则为 6 条）
    expect(stub.seenMessages).toHaveLength(7);
  });

  test('预算超限：子代理 maxTurns 用尽 → halted → 失败回喂主代理', async () => {
    const stub = new StubProvider([
      // 子代理只给 1 轮：第一轮调工具，下一轮就被轮次上限掐断
      taskUseEvents('快速任务', { tools: ['noop'], maxTurns: 1 }),
      toolUseEvents('noop', {}),
      textEvents('子代理失败了，我将告知用户。'),
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
    // 子代理 halted → ok:false 回喂主代理（forModel 带失败原因）
    const secondRequest = stub.seenMessages[2];
    expect(toolResultOutput(secondRequest)).toEqual(
      expect.objectContaining({
        type: 'error-text',
        value: expect.stringContaining('预算超限'),
      }),
    );
  });

  test('超时：timeoutMs 到点 → 中止子代理 → 失败回喂主代理', async () => {
    const stub = new StubProvider([
      taskUseEvents('慢任务', { timeoutMs: 30 }),
      { hang: true },
      textEvents('子代理超时了，任务未完成。'),
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
    const secondRequest = stub.seenMessages[2];
    expect(toolResultOutput(secondRequest)).toEqual(
      expect.objectContaining({
        type: 'error-text',
        value: expect.stringContaining('超时'),
      }),
    );
  });

  test('供应商错误：子代理执行出错 → ok:false 回喂主代理（错误即数据）', async () => {
    const stub = new StubProvider([
      taskUseEvents('可能失败的任务'),
      // kind: unknown → 不可重试，立即按错误终止（不触发退避重试，保持测试快速）
      { throw: new ProviderError({ kind: 'unknown', message: '上游异常' }) },
      textEvents('子代理失败了，我将告知用户。'),
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
    const secondRequest = stub.seenMessages[2];
    expect(toolResultOutput(secondRequest)).toEqual(
      expect.objectContaining({
        type: 'error-text',
        value: expect.stringContaining('失败'),
      }),
    );
  });

  test('权限继承：子代理副作用调用经同一审批闸门（allow_always 记忆跨 agent 生效）', async () => {
    const seenRequests: string[] = [];
    const gate = new ApprovalGate({
      decider: async (request) => {
        seenRequests.push(request.toolName);
        return { decision: 'allow_always', source: 'user' };
      },
    });

    // 父代理先直接调用一次 fakewrite（同路径）→ 闸门记忆 allow_always
    const parentOutcome = await runToolPipeline(
      { id: 'p1', name: 'fakewrite', input: { path: '/tmp/shared.txt' } },
      { registry: parentRegistry(), authorize: gate },
    );
    expect(parentOutcome.ok).toBe(true);
    expect(seenRequests).toEqual(['fakewrite']);

    // 子代理白名单含 fakewrite，同样路径 → 记忆命中，闸门不再询问
    const stub = new StubProvider([
      taskUseEvents('写共享文件', { tools: ['fakewrite'] }),
      toolUseEvents('fakewrite', { path: '/tmp/shared.txt' }),
      textEvents('已写入共享文件。'),
      textEvents('收到。'),
    ]);

    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [userMsg],
        tools: parentRegistry(),
        approval: gate,
        options: { maxTurns: 6 },
      },
      () => {},
    );

    expect(result.termination).toBe('end_turn');
    // 子代理的 fakewrite 调用经同一闸门，且 memory 命中未再询问
    expect(seenRequests).toEqual(['fakewrite']);
    const subWriteResult = toolResultOutput(stub.seenMessages[2]);
    expect(subWriteResult).toEqual(
      expect.objectContaining({ type: 'text', value: '已写入（测试替身）' }),
    );
  });

  test('一层深：createSubagentRunner depth ≥ 1 拒绝且不消耗 provider 轮次', async () => {
    const stub = new StubProvider([]);
    const runner = createSubagentRunner({
      runTurn: runAgentTurn,
      provider: stub,
      parentRegistry: parentRegistry(),
      readFiles: new Set<string>(),
      cwd: process.cwd(),
      depth: 1,
    });
    const result = await runner({ prompt: '再派一层' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('一层深');
    expect(stub.seenMessages).toHaveLength(0); // 未发起任何 provider 请求
  });
});

describe('子代理已读集合回传（0.12.1 修复）', () => {
  test('子代理 Read 的文件并入父已读集合：主代理可直接覆盖写（防盲写不拒）', async () => {
    // 真实文件：子代理用真实 read 工具读到它，主代理随后用真实 write 工具
    // 覆盖写它——若子代理的已读没回传，write 的防盲写检查会以
    // not_read_before_overwrite 拒绝（文件已存在且主代理从未读过）。
    const dir = mkdtempSync(join(tmpdir(), 'modou-sub-read-'));
    const target = join(dir, 'shared.txt');
    writeFileSync(target, '原始内容');

    const stub = new StubProvider([
      taskUseEvents('读取 shared.txt 并回报内容'),
      toolUseEvents('read', { path: target }, 'call-sub-read'),
      textEvents('文件内容是：原始内容'),
      toolUseEvents(
        'write',
        { path: target, content: '新内容', overwrite: true },
        'call-main-write',
      ),
      textEvents('已覆盖写 shared.txt。'),
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
    // 已读集合带出子代理 Read 过的文件（TurnResult.readFiles；realpath 口径）
    const realTarget = realpathSync(target);
    expect(result.readFiles.has(realTarget)).toBe(true);
    // 主代理随后覆盖写成功：文件内容已变（若防盲写拒绝，文件保持原文案）
    expect(readFileSync(target, 'utf8')).toBe('新内容');
  });
});
