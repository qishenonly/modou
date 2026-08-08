/**
 * T-130 非交互模式增强（0.13.0「能进流水线」）离线测试。
 *
 * 覆盖：
 * - runAgentTurnJson：事件流收集为 JSON（含 text / tool / usage / turn_end）、
 *   JSON 可解析、result 为 JSON-safe 投影（无 class / Set 实例）；
 * - 退出码语义化：成功 0 / 失败 1 / 超限 2 / 需审批 3 / 中断 130；
 * - 无人值守审批默认拒绝（ADR 0012）：程序化入口未注入 decider 时，
 *   需审批操作被默认拒绝且绝不静默——事件流出现 approval_resolved deny、
 *   tool_result ok:false 回喂模型、退出码 3；
 * - readStdinPrompt：stdin 管道输入（Buffer / string chunk 拼接 + 去空白）。
 *
 * 全部离线：provider 用本地 StubProvider（不访问外网）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import type { ProviderCapabilities } from '../provider/capabilities';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
} from '../provider/types';
import { ProviderError } from '../provider/errors';
import { ToolRegistry } from '../tools/registry';
import { runAgentTurnJson, readStdinPrompt, RunExitCode } from './json';
import { exitCodeFor } from './json';

// ---------------------------------------------------------------------------
// 本地 StubProvider（与 runtime.test.ts 同款替身：按调用顺序消费 rounds）
// ---------------------------------------------------------------------------

const CAPABILITIES: ProviderCapabilities = {
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
  readonly capabilities: ProviderCapabilities;
  /** 每次 streamChat 收到的消息（验证多模态构造等）。 */
  readonly seenMessages: ModelMessage[][] = [];
  private callCount = 0;

  constructor(
    private readonly rounds: StubRound[],
    capabilities: ProviderCapabilities = CAPABILITIES,
  ) {
    this.capabilities = capabilities;
  }

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    if (input.abortSignal?.aborted) {
      throw new ProviderError({ kind: 'aborted', message: '请求已被中断' });
    }
    this.seenMessages.push(input.messages);
    const round = this.rounds[Math.min(this.callCount, this.rounds.length - 1)];
    this.callCount += 1;
    if ('throw' in round) throw round.throw;
    for (const event of round) yield event;
  }
}

// ---------------------------------------------------------------------------
// 事件序列构造
// ---------------------------------------------------------------------------

const userMsg: ModelMessage = { role: 'user', content: '你好' };

function textEvents(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', delta: text },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: 'stop' },
  ];
}

function toolUseEvents(
  name = 'bash',
  id = 'call-1',
  input: unknown = { cmd: 'ls' },
): StreamEvent[] {
  return [
    { type: 'tool_use', id, name, input },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: 'tool_use' },
  ];
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runAgentTurnJson（T-130 事件流 JSON 收集）', () => {
  test('成功轮：事件流可解析为 JSON，含 text/usage/turn_end，退出码 0', async () => {
    const stub = new StubProvider([textEvents('你好世界')]);
    const out = await runAgentTurnJson({
      provider: stub,
      messages: [userMsg],
      options: { maxTurns: 5 },
    });

    expect(out.exitCode).toBe(RunExitCode.SUCCESS);
    // 事件流是可 JSON 序列化的信封数组
    const json = JSON.stringify(out.events);
    expect(json.length).toBeGreaterThan(0);
    const parsed = JSON.parse(json) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(out.events.length);

    const types = out.events.map((event) => event.type);
    expect(types).toContain('turn_start');
    expect(types).toContain('text_delta');
    expect(types).toContain('usage');
    expect(types).toContain('turn_end');
    // 文本按 delta 收集
    expect(out.result.text).toBe('你好世界');
    // JSON-safe 投影：budget 为纯对象快照、readFiles 为数组
    expect(out.result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(typeof out.result.budget.inputTokens).toBe('number');
    expect(Array.isArray(out.result.readFiles)).toBe(true);
    // 整体可再序列化（投影不含 Set / class 实例）
    expect(() => JSON.stringify(out.result)).not.toThrow();
  });

  test('工具轮：tool_call / tool_result 进入事件流，入参经脱敏', async () => {
    const stub = new StubProvider([
      toolUseEvents('bash', 'call-1', { cmd: 'echo sk-abc123' }),
      textEvents('完成'),
    ]);
    const tools = new ToolRegistry();
    // 只读 echo 工具：不触发审批，聚焦事件流收集
    tools.register({
      name: 'echo',
      description: '回显（测试）',
      risk: 'read',
      schema: z.object({ text: z.string() }),
      execute: async () => ({ ok: true, forModel: 'echo' }),
    });
    const out = await runAgentTurnJson({
      provider: stub,
      tools,
      messages: [userMsg],
      options: { maxTurns: 5 },
    });

    const toolCalls = out.events.filter((event) => event.type === 'tool_call');
    expect(toolCalls.length).toBe(1);
    expect(out.events.some((event) => event.type === 'tool_result')).toBe(true);
    expect(out.exitCode).toBe(RunExitCode.SUCCESS);
  });

  test('only 过滤：只收集指定类型的事件', async () => {
    const stub = new StubProvider([textEvents('你好')]);
    const out = await runAgentTurnJson(
      {
        provider: stub,
        messages: [userMsg],
        options: { maxTurns: 5 },
      },
      { only: new Set(['usage', 'turn_end']) },
    );
    expect(out.events.length).toBeGreaterThan(0);
    for (const event of out.events) {
      expect(['usage', 'turn_end']).toContain(event.type);
    }
  });

  test('images 选项（T-133）：支持图片的模型收到文本 + 图片的多模态消息', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'modou-json-image-'));
    tmpDirs.push(dir);
    const pngPath = join(dir, 'shot.png');
    // 1x1 最小 PNG
    writeFileSync(
      pngPath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const stub = new StubProvider([textEvents('已看图')], {
      ...CAPABILITIES,
      images: true,
    });
    const out = await runAgentTurnJson(
      {
        provider: stub,
        messages: [userMsg],
        options: { maxTurns: 5 },
      },
      { images: [pngPath] },
    );

    // 降级 notice 为空（支持路径），消息以多模态形态发给 provider
    expect(out.notices).toEqual([]);
    expect(out.exitCode).toBe(RunExitCode.SUCCESS);
    const seen = stub.seenMessages[0];
    expect(seen).toBeDefined();
    const last = seen[seen.length - 1];
    expect(Array.isArray(last?.content)).toBe(true);
    const parts = last?.content as Array<{
      type: string;
      mediaType?: string;
      data?: { type: string; data?: unknown };
    }>;
    expect(parts.some((part) => part.type === 'file')).toBe(true);
    expect(
      parts.some(
        (part) =>
          part.type === 'file' &&
          part.mediaType === 'image/png' &&
          part.data?.data instanceof Uint8Array,
      ),
    ).toBe(true);
  });

  test('images 选项（T-133）：不支持图片的模型降级——notice 说明且消息为纯文本', async () => {
    const stub = new StubProvider([textEvents('抱歉，我看不到图')]);
    const out = await runAgentTurnJson(
      {
        provider: stub,
        messages: [userMsg],
        options: { maxTurns: 5 },
      },
      { images: ['/tmp/whatever.png'] },
    );
    expect(out.notices.length).toBe(1);
    expect(out.notices[0]).toContain('不支持图片输入');
    // provider 收到的消息是纯文本（含「不要臆测图片内容」说明）
    const seen = stub.seenMessages[0];
    expect(seen).toBeDefined();
    expect(typeof seen[seen.length - 1]?.content).toBe('string');
  });
});

describe('退出码语义化（T-130）', () => {
  test('成功 → 0', async () => {
    const stub = new StubProvider([textEvents('ok')]);
    const out = await runAgentTurnJson({
      provider: stub,
      messages: [userMsg],
      options: { maxTurns: 5 },
    });
    expect(out.exitCode).toBe(0);
  });

  test('供应商错误 → 1（maxAttempts 1 避免退避等待）', async () => {
    const stub = new StubProvider([
      { throw: new ProviderError({ kind: 'rate_limited', message: '限流' }) },
    ]);
    const out = await runAgentTurnJson({
      provider: stub,
      messages: [userMsg],
      options: {
        maxTurns: 5,
        retry: { maxAttempts: 1, baseDelayMs: 0 },
      },
    });
    expect(out.exitCode).toBe(RunExitCode.FAILURE);
    expect(out.result.termination).toBe('error');
    expect(out.events.some((event) => event.type === 'error')).toBe(true);
  });

  test('轮次超限 → 2（halted）', async () => {
    // 永远 tool_use 的循环：maxTurns=1 立刻超限
    const stub = new StubProvider([toolUseEvents()]);
    const tools = new ToolRegistry();
    tools.register({
      name: 'echo',
      description: '回显（测试）',
      risk: 'read',
      schema: z.object({ text: z.string() }),
      execute: async () => ({ ok: true, forModel: 'echo' }),
    });
    const out = await runAgentTurnJson({
      provider: stub,
      tools,
      messages: [userMsg],
      options: { maxTurns: 1 },
    });
    expect(out.result.termination).toBe('halted');
    expect(out.exitCode).toBe(RunExitCode.HALTED);
  });

  test('需审批（默认拒绝）→ 3：绝不静默放行（ADR 0012）', async () => {
    const stub = new StubProvider([
      toolUseEvents('bash', 'call-1', { cmd: 'ls' }),
      textEvents('已回退作答'),
    ]);
    // bash 工具（risk=exec）→ 未注入审批 decider 时 runAgentTurnJson 自动装配
    // 默认拒绝闸门 → approval_resolved deny → tool_result ok:false → 退出码 3
    const bashTool = {
      name: 'bash',
      description: '执行命令（测试）',
      risk: 'exec' as const,
      schema: z.object({ cmd: z.string() }),
      execute: async () => ({ ok: true, forModel: 'ran' }),
    };
    const tools = new ToolRegistry();
    tools.register(bashTool);
    const out = await runAgentTurnJson({
      provider: stub,
      tools,
      messages: [userMsg],
      options: { maxTurns: 5 },
    });

    // 审批被拒绝且明确可见：approval_request + approval_resolved(deny)
    const resolved = out.events.find(
      (event) => event.type === 'approval_resolved',
    );
    expect(resolved).toBeDefined();
    expect(resolved?.data.decision).toBe('deny');
    // 工具结果回喂 ok:false（策略性拒绝，模型得到可诊断文本而非成功结果）
    const toolResults = out.events.filter(
      (event) => event.type === 'tool_result',
    );
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]?.data.ok).toBe(false);
    // 退出码 = 3（需审批），CI 应转人审阅
    expect(out.exitCode).toBe(RunExitCode.APPROVAL_REQUIRED);
  });

  test('中断 → 130（interrupted）', async () => {
    const controller = new AbortController();
    controller.abort();
    const stub = new StubProvider([textEvents('你好')]);
    const out = await runAgentTurnJson({
      provider: stub,
      messages: [userMsg],
      options: { maxTurns: 5, abortSignal: controller.signal },
    });
    expect(out.exitCode).toBe(RunExitCode.INTERRUPTED);
  });
});

describe('readStdinPrompt（T-130 stdin 管道输入）', () => {
  test('Buffer chunk 拼接并按 UTF-8 解码、去首尾空白', async () => {
    const input = async function* (): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('修复 lint 错误');
      yield new TextEncoder().encode('，并跑测试');
    };
    const prompt = await readStdinPrompt(input());
    expect(prompt).toBe('修复 lint 错误，并跑测试');
  });

  test('string chunk 直接拼接；空输入返回空串', async () => {
    const prompt = await readStdinPrompt(['  ', 'hello', '  ']);
    expect(prompt).toBe('hello');
    expect(await readStdinPrompt([])).toBe('');
  });
});

describe('exitCodeFor（纯函数：事件流 + 结果 → 退出码）', () => {
  test('无需收集时可直接判定', () => {
    const fakeResult = {
      termination: 'error' as const,
    };
    expect(exitCodeFor([], fakeResult as never)).toBe(RunExitCode.FAILURE);
  });
});
