import { describe, expect, test } from 'bun:test';
import { jsonSchema, simulateReadableStream, tool } from 'ai';
import type { ToolSet } from 'ai';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import {
  ANTHROPIC_DEFAULT_CAPABILITIES,
  createAnthropicProvider,
} from './anthropic';
import {
  createOpenAICompatProvider,
  OPENAI_COMPAT_DEFAULT_CAPABILITIES,
} from './openai-compat';
import { readOpencodeEnv } from './providers';
import type { ProviderCapabilities } from './capabilities';
import type { StreamChatInput, StreamEvent } from './types';
import { computeCacheHitRate, VercelModelProvider } from './vercel';
import { applyCacheBreakpoints } from './vercel';
import { BudgetLedger } from '../context/budget';
import { runAgentTurn } from '../runtime/loop';
import type { RuntimeEvent } from '../runtime/loop';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import { createSummaryState, merge } from '../context/summary';

// ---------------------------------------------------------------------------
// T-071 Prompt caching：缓存断点注入 + 命中率上报。
//
// 覆盖：
// 1. `applyCacheBreakpoints` 纯函数：断点 ①（稳定前缀：有工具打在最后一个
//    工具、无工具打在 system）与断点 ②（摘要块：messages 最后一条 system
//    消息）的装配逻辑；
// 2. provider 层集成：真实 VercelModelProvider + 捕获 providerOptions 的
//    AI SDK v4 假模型——`cacheBreakpoints: true` 时断点出现在 streamText
//    转出的 prompt / tools 上（连续两轮请求均设置），`false` 时完全不设；
// 3. 命中率：computeCacheHitRate / toTokenUsage 透出的 cacheHitRate /
//    BudgetLedger.cacheHitRate 累计（compaction 改写摘要块后累计命中率下降）；
// 4. loop 集成：压缩投影把摘要块作为 system 消息送出，断点 ① / ② 同时落在
//    providerOptions 上，TurnResult.usage 带累计命中率；
// 5. 真实端点冒烟（门控，见文件尾）：openai-compat 重复请求验证缓存分项
//    上报；anthropic（opt-in MODOU_LIVE_CACHE=1）验证 cacheRead 出现。
// ---------------------------------------------------------------------------

const noDelay = {
  _internal: { delay: () => Promise.resolve() },
  initialDelayInMs: 0,
  chunkDelayInMs: 0,
};

const STOP_REASON = { unified: 'stop' as const, raw: undefined };
const TOOL_REASON = { unified: 'tool-calls' as const, raw: 'tool_calls' };

function v4Usage(
  overrides: {
    inputTotal?: number;
    outputTotal?: number;
    noCache?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } = {},
): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: overrides.inputTotal ?? 7,
      noCache: overrides.noCache,
      cacheRead: overrides.cacheRead,
      cacheWrite: overrides.cacheWrite,
    },
    outputTokens: {
      total: overrides.outputTotal ?? 3,
      text: undefined,
      reasoning: undefined,
    },
  };
}

function textParts(usage: LanguageModelV4Usage): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: '你' },
    { type: 'text-delta', id: 't1', delta: '好' },
    { type: 'text-end', id: 't1' },
    { type: 'finish', usage, finishReason: STOP_REASON },
  ];
}

function toolCallParts(): LanguageModelV4StreamPart[] {
  return [
    {
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'bash',
      // AI SDK 会把合法 JSON 字符串解析成对象，管线据此校验工具参数
      input: '{"cmd":"echo ok"}',
    },
    {
      type: 'finish',
      usage: v4Usage({ inputTotal: 50, outputTotal: 5 }),
      finishReason: TOOL_REASON,
    },
  ];
}

/**
 * 捕获 providerOptions 的 AI SDK v4 假模型：
 * 每次 doStream 收到调用选项（含 prompt / tools 的 providerOptions），
 * 按调用序依次消费 rounds（用尽后重放最后一轮）。
 */
class CapturingV4Model implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'test';
  readonly modelId = 'capture-v4';
  readonly supportedUrls = {};
  /** 每次 doStream 收到的调用选项（断言 providerOptions 用）。 */
  readonly seenOptions: LanguageModelV4CallOptions[] = [];
  private callCount = 0;

  constructor(private readonly rounds: LanguageModelV4StreamPart[][]) {}

  async doGenerate() {
    return {
      content: [],
      finishReason: STOP_REASON,
      usage: v4Usage(),
      warnings: [],
    };
  }

  async doStream(options: LanguageModelV4CallOptions) {
    this.seenOptions.push(options);
    const round = this.rounds[Math.min(this.callCount, this.rounds.length - 1)];
    this.callCount += 1;
    return { stream: simulateReadableStream({ chunks: round, ...noDelay }) };
  }
}

/** 假模型经 createModel 包装进 VercelModelProvider 的辅助。 */
function makeCapturingProvider(
  model: CapturingV4Model,
  capabilities: ProviderCapabilities,
): VercelModelProvider {
  return new VercelModelProvider({
    id: 'anthropic',
    modelId: 'capture-model',
    capabilities,
    createModel: () => model,
  });
}

const CHAT_INPUT: StreamChatInput = {
  messages: [{ role: 'user', content: '你好' }],
};

/** Anthropic 的缓存断点 providerOptions 形态（`cache_control: {type:'ephemeral'}`）。 */
const EPHEMERAL_OPTIONS = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
};

/** 读一条 v4 prompt 消息的 anthropic cacheControl。 */
function cacheControlOf(message: { providerOptions?: unknown }): unknown {
  const options = message.providerOptions as
    { anthropic?: { cacheControl?: unknown } } | undefined;
  return options?.anthropic?.cacheControl;
}

/** 读一个 v4 工具定义的 anthropic cacheControl（provider 工具无此字段）。 */
function toolCacheControl(
  tool: LanguageModelV4FunctionTool | { type: 'provider' },
): unknown {
  if (tool.type !== 'function') return undefined;
  const options = tool.providerOptions as
    { anthropic?: { cacheControl?: unknown } } | undefined;
  return options?.anthropic?.cacheControl;
}

const BASH_TOOL: ToolSet = {
  read: tool({
    description: '读文件',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }),
  }),
  bash: tool({
    description: '运行 shell 命令',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { cmd: { type: 'string' } },
      required: ['cmd'],
    }),
  }),
};

// ---------------------------------------------------------------------------
// applyCacheBreakpoints 纯函数
// ---------------------------------------------------------------------------

describe('applyCacheBreakpoints（002 7.1 断点 ①/② 装配）', () => {
  test('有工具：断点 ① 打在最后一个工具，system 保持字符串不动', () => {
    const hints = applyCacheBreakpoints('anthropic', {
      system: '你是 modou',
      tools: BASH_TOOL,
      messages: [{ role: 'user', content: '你好' }],
    });

    // system 未被改成数组（断点不在 system 上）
    expect(hints.system).toBe('你是 modou');
    // 最后一个工具（bash）挂上 ephemeral 断点
    const tools = hints.tools!;
    expect(
      (
        tools.bash?.providerOptions as
          | {
              anthropic?: { cacheControl?: unknown };
            }
          | undefined
      )?.anthropic?.cacheControl,
    ).toEqual({ type: 'ephemeral' });
    // 第一个工具（read）不设断点
    expect(
      (tools.read?.providerOptions as { anthropic?: unknown } | undefined)
        ?.anthropic,
    ).toBeUndefined();
  });

  test('无工具：断点 ① 打在 system（转为 SystemModelMessage 数组）', () => {
    const hints = applyCacheBreakpoints('anthropic', {
      system: '你是 modou',
      messages: [{ role: 'user', content: '你好' }],
    });

    expect(hints.system).toEqual([
      {
        role: 'system',
        content: '你是 modou',
        providerOptions: EPHEMERAL_OPTIONS,
      },
    ]);
  });

  test('断点 ② 打在 messages 最后一条 system 消息（压缩摘要块）', () => {
    const hints = applyCacheBreakpoints('anthropic', {
      system: '你是 modou',
      tools: BASH_TOOL,
      messages: [
        { role: 'system', content: '【压缩摘要 rev=1】' },
        { role: 'user', content: '当前输入' },
      ],
    });

    const summary = hints.messages[0];
    expect(cacheControlOf(summary)).toEqual({ type: 'ephemeral' });
    const user = hints.messages[1];
    expect(cacheControlOf(user)).toBeUndefined();
  });

  test('多条 system 消息：只给最后一条挂断点 ②', () => {
    const hints = applyCacheBreakpoints('anthropic', {
      messages: [
        { role: 'system', content: '早期' },
        { role: 'user', content: 'a' },
        { role: 'system', content: '最新摘要' },
      ],
    });
    expect(cacheControlOf(hints.messages[0])).toBeUndefined();
    expect(cacheControlOf(hints.messages[2])).toEqual({ type: 'ephemeral' });
  });

  test('没有 system 消息：messages 原样返回（断点 ② 不生效）', () => {
    const input: StreamChatInput = {
      messages: [{ role: 'user', content: 'hi' }],
    };
    const hints = applyCacheBreakpoints('anthropic', input);
    expect(hints.messages).toEqual(input.messages);
  });

  test('system 为空串：不设 system 断点（无内容可缓存）', () => {
    const hints = applyCacheBreakpoints('anthropic', {
      system: '',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(hints.system).toBe('');
  });
});

// ---------------------------------------------------------------------------
// computeCacheHitRate 纯函数
// ---------------------------------------------------------------------------

describe('computeCacheHitRate（命中率 = cacheRead / (cacheRead + noCache)）', () => {
  test('正常命中率', () => {
    expect(computeCacheHitRate(60, 40)).toBe(0.6);
    expect(computeCacheHitRate(0, 100)).toBe(0);
    expect(computeCacheHitRate(100, 0)).toBe(1);
  });

  test('缺任一字段 → undefined（供应商未上报缓存分项）', () => {
    expect(computeCacheHitRate(undefined, 40)).toBeUndefined();
    expect(computeCacheHitRate(60, undefined)).toBeUndefined();
    expect(computeCacheHitRate(undefined, undefined)).toBeUndefined();
  });

  test('全零 → undefined（无输入 token 无从谈命中率）', () => {
    expect(computeCacheHitRate(0, 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// provider 层集成：断点注入落到 streamText 转出的 prompt / tools
// ---------------------------------------------------------------------------

describe('VercelModelProvider 缓存断点注入（stub 捕获 providerOptions）', () => {
  test('cacheBreakpoints=true：断点 ① 在最后一个工具、断点 ② 在摘要块 system 消息', async () => {
    const model = new CapturingV4Model([textParts(v4Usage())]);
    const provider = makeCapturingProvider(
      model,
      ANTHROPIC_DEFAULT_CAPABILITIES, // cacheBreakpoints: true
    );

    await collect(provider, {
      system: '你是 modou',
      tools: BASH_TOOL,
      messages: [
        { role: 'system', content: '【压缩摘要 rev=1】目标：修 bug' },
        { role: 'user', content: '继续' },
      ],
    });

    const options = model.seenOptions[0];
    // 断点 ①：最后一个工具定义挂 ephemeral（v4 转出 tools 数组）
    const lastTool = options.tools?.at(-1);
    expect(lastTool?.name).toBe('bash');
    expect(toolCacheControl(lastTool!)).toEqual({ type: 'ephemeral' });

    // 断点 ②：摘要块 system 消息挂 ephemeral
    const prompt = options.prompt;
    const summary = prompt.find(
      (message) =>
        message.role === 'system' && message.content.includes('压缩摘要'),
    );
    expect(summary).toBeDefined();
    expect(cacheControlOf(summary!)).toEqual({ type: 'ephemeral' });

    // 系统提示词消息（system 参数转出）不设断点（断点 ① 已移到工具上）
    const systemPrompt = prompt.find(
      (message) =>
        message.role === 'system' && message.content === '你是 modou',
    );
    expect(cacheControlOf(systemPrompt!)).toBeUndefined();
  });

  test('cacheBreakpoints=true 且无工具：断点 ① 落在 system 上', async () => {
    const model = new CapturingV4Model([textParts(v4Usage())]);
    const provider = makeCapturingProvider(
      model,
      ANTHROPIC_DEFAULT_CAPABILITIES,
    );

    await collect(provider, {
      system: '你是 modou',
      messages: [{ role: 'user', content: '你好' }],
    });

    const options = model.seenOptions[0];
    const systemPrompt = options.prompt.find(
      (message) =>
        message.role === 'system' && message.content === '你是 modou',
    );
    expect(cacheControlOf(systemPrompt!)).toEqual({ type: 'ephemeral' });
    expect(options.tools).toBeUndefined();
  });

  test('连续两轮请求：断点 ① / ② 每轮都设置（稳定前缀跨轮命中）', async () => {
    const model = new CapturingV4Model([
      textParts(v4Usage()),
      textParts(v4Usage()),
    ]);
    const provider = makeCapturingProvider(
      model,
      ANTHROPIC_DEFAULT_CAPABILITIES,
    );
    const input: StreamChatInput = {
      system: '你是 modou',
      tools: BASH_TOOL,
      messages: [
        { role: 'system', content: '【压缩摘要 rev=1】' },
        { role: 'user', content: '继续' },
      ],
    };

    await collect(provider, input);
    await collect(provider, input);

    expect(model.seenOptions).toHaveLength(2);
    for (const options of model.seenOptions) {
      const lastTool = options.tools?.at(-1);
      expect(toolCacheControl(lastTool!)).toEqual({ type: 'ephemeral' });
      const summary = options.prompt.find(
        (message) =>
          message.role === 'system' && message.content.includes('压缩摘要'),
      );
      expect(cacheControlOf(summary!)).toEqual({ type: 'ephemeral' });
    }
  });

  test('cacheBreakpoints=false：不注入任何 providerOptions', async () => {
    const model = new CapturingV4Model([textParts(v4Usage())]);
    const provider = makeCapturingProvider(
      model,
      OPENAI_COMPAT_DEFAULT_CAPABILITIES, // cacheBreakpoints: false
    );

    await collect(provider, {
      system: '你是 modou',
      tools: BASH_TOOL,
      messages: [
        { role: 'system', content: '【压缩摘要 rev=1】' },
        { role: 'user', content: '继续' },
      ],
    });

    const options = model.seenOptions[0];
    for (const message of options.prompt) {
      expect(cacheControlOf(message)).toBeUndefined();
    }
    for (const tool of options.tools ?? []) {
      expect(toolCacheControl(tool)).toBeUndefined();
    }
  });

  test('usage 事件带 cacheHitRate（供应商上报缓存分项时）', async () => {
    const model = new CapturingV4Model([
      textParts(
        v4Usage({
          inputTotal: 100,
          outputTotal: 5,
          noCache: 40,
          cacheRead: 60,
        }),
      ),
    ]);
    const provider = makeCapturingProvider(
      model,
      ANTHROPIC_DEFAULT_CAPABILITIES,
    );

    const events = await collect(provider, CHAT_INPUT);
    const usageEvent = events.find((event) => event.type === 'usage');
    expect(usageEvent?.type).toBe('usage');
    if (usageEvent?.type === 'usage') {
      expect(usageEvent.usage.cacheReadTokens).toBe(60);
      expect(usageEvent.usage.noCacheTokens).toBe(40);
      expect(usageEvent.usage.cacheHitRate).toBe(0.6);
    }
  });

  test('usage 事件：未上报缓存分项时 cacheHitRate 为 undefined', async () => {
    const model = new CapturingV4Model([textParts(v4Usage())]);
    const provider = makeCapturingProvider(
      model,
      ANTHROPIC_DEFAULT_CAPABILITIES,
    );

    const events = await collect(provider, CHAT_INPUT);
    const usageEvent = events.find((event) => event.type === 'usage');
    expect(usageEvent?.type).toBe('usage');
    if (usageEvent?.type === 'usage') {
      expect(usageEvent.usage.cacheHitRate).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// BudgetLedger 累计命中率
// ---------------------------------------------------------------------------

describe('BudgetLedger.cacheHitRate（跨请求累计，compaction 后反映）', () => {
  test('两笔请求：命中率按累计口径计算', () => {
    const ledger = new BudgetLedger();
    // 请求 1：稳定前缀首付全价（写缓存）→ cacheRead 0 / noCache 100
    ledger.recordUsage({
      inputTokens: 100,
      cacheReadTokens: 0,
      noCacheTokens: 100,
    });
    // 请求 2：稳定前缀命中缓存 → cacheRead 80 / noCache 20
    ledger.recordUsage({
      inputTokens: 100,
      cacheReadTokens: 80,
      noCacheTokens: 20,
    });
    expect(ledger.cacheHitRate()).toBe(80 / 200);
  });

  test('压缩改写摘要块后：稳定前缀仍命中，摘要块转写 → 累计命中率下降', () => {
    const ledger = new BudgetLedger();
    // 压缩前：两轮全部命中稳定前缀 → 命中率 0.9
    ledger.recordUsage({
      inputTokens: 100,
      cacheReadTokens: 90,
      noCacheTokens: 10,
    });
    ledger.recordUsage({
      inputTokens: 100,
      cacheReadTokens: 90,
      noCacheTokens: 10,
    });
    const before = ledger.cacheHitRate();
    expect(before).toBe(0.9);
    // 压缩后：摘要块变化，该块重新计费（noCache 上升）→ 累计命中率下降
    ledger.recordUsage({
      inputTokens: 100,
      cacheReadTokens: 70,
      noCacheTokens: 30,
    });
    const after = ledger.cacheHitRate();
    expect(after).toBeLessThan(before!);
    expect(after).toBe(250 / 300);
  });

  test('没有任何缓存分项上报：返回 undefined', () => {
    const ledger = new BudgetLedger();
    ledger.recordUsage({ inputTokens: 10, outputTokens: 5 });
    expect(ledger.cacheHitRate()).toBeUndefined();
  });

  test('rebuild 从 usage 条目重建后命中率一致（/resume）', () => {
    const ledger = BudgetLedger.rebuild([
      { inputTokens: 100, cacheReadTokens: 0, noCacheTokens: 100 },
      { inputTokens: 100, cacheReadTokens: 80, noCacheTokens: 20 },
    ]);
    expect(ledger.cacheHitRate()).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// loop 集成：压缩投影 → 断点 ①/② 落在真实请求；TurnResult.usage 带命中率
// ---------------------------------------------------------------------------

/** 极简 stub 工具（不经文件系统，管线执行直接返回）。 */
function stubTool(name: string, description: string): Tool {
  return {
    name,
    description,
    schema: z.object({}),
    risk: 'read',
    execute: async () => ({ ok: true, forModel: `stub:${name}` }),
  };
}

describe('runAgentTurn 缓存接入（loop/context 投影分段 + 命中率上报）', () => {
  test('压缩投影后：断点 ①（工具）+ 断点 ②（摘要块）落到真实请求', async () => {
    const model = new CapturingV4Model([
      textParts(
        v4Usage({
          inputTotal: 100,
          outputTotal: 5,
          noCache: 40,
          cacheRead: 60,
        }),
      ),
    ]);
    const provider = createAnthropicProvider({
      modelId: 'claude-test',
      createModel: () => model,
    });
    const registry = new ToolRegistry()
      .register(stubTool('read', '读文件'))
      .register(stubTool('bash', '运行命令'));

    const thread: ModelMessage[] = [
      { role: 'user', content: '任务开始' },
      { role: 'assistant', content: 'fact-1 详情' },
      { role: 'user', content: '读文件' },
      { role: 'assistant', content: 'fact-2 详情' },
      { role: 'user', content: '当前输入' },
    ];
    const state = merge(createSummaryState(), { goal: '长任务' });

    const result = await runAgentTurn({
      provider,
      system: '你是 modou',
      messages: thread,
      tools: registry,
      summaryState: state,
      compact: {
        keepTurns: 2,
        thresholdTokens: 1, // 小阈值 → 必触发压缩
        generateDelta: async () => ({
          findings: [{ id: 'f', text: '已折叠早期轮次' }],
        }),
      },
      options: { maxTurns: 1 },
    });

    const options = model.seenOptions[0];
    // 断点 ①：最后一个工具定义（bash，注册顺序在后）
    const lastTool = options.tools?.at(-1);
    expect(lastTool?.name).toBe('bash');
    expect(toolCacheControl(lastTool!)).toEqual({ type: 'ephemeral' });

    // 断点 ②：摘要块 system 消息（压缩投影产物）挂 ephemeral
    const summary = options.prompt.find(
      (message) =>
        message.role === 'system' && message.content.includes('压缩摘要'),
    );
    expect(summary).toBeDefined();
    expect(cacheControlOf(summary!)).toEqual({ type: 'ephemeral' });

    // TurnResult.usage 带累计命中率（0.6 = 60 / (60 + 40)）
    expect(result.usage.cacheReadTokens).toBe(60);
    expect(result.usage.noCacheTokens).toBe(40);
    expect(result.usage.cacheHitRate).toBe(0.6);
    // 预算账本累计命中率同源
    expect(result.budget.cacheHitRate()).toBe(0.6);
  });

  test('未启用压缩：无摘要块 → 断点 ② 不生效（仍发断点 ① 于工具）', async () => {
    const model = new CapturingV4Model([
      textParts(v4Usage({ inputTotal: 10, outputTotal: 5 })),
    ]);
    const provider = createAnthropicProvider({
      modelId: 'claude-test',
      createModel: () => model,
    });
    const registry = new ToolRegistry().register(stubTool('read', '读文件'));

    await runAgentTurn({
      provider,
      system: '你是 modou',
      messages: [{ role: 'user', content: '你好' }],
      tools: registry,
      options: { maxTurns: 1 },
    });

    const options = model.seenOptions[0];
    // 无摘要块：prompt 里只有系统提示词 + user，没有任何带断点的 system 消息
    const breakpointedSystem = options.prompt.filter(
      (message) =>
        message.role === 'system' && cacheControlOf(message) !== undefined,
    );
    expect(breakpointedSystem).toHaveLength(0);
    // 断点 ① 仍在最后一个工具上
    const lastTool = options.tools?.at(-1);
    expect(toolCacheControl(lastTool!)).toEqual({ type: 'ephemeral' });
  });

  test('多轮工具循环：两轮请求的 usage 累计命中率（TurnResult.usage）', async () => {
    // 第一轮：模型发 tool-call → loop 执行工具 → 第二轮：文本收尾
    const model = new CapturingV4Model([
      toolCallParts(),
      textParts(
        v4Usage({ inputTotal: 80, outputTotal: 4, noCache: 20, cacheRead: 60 }),
      ),
    ]);
    const provider = createAnthropicProvider({
      modelId: 'claude-test',
      createModel: () => model,
    });
    const registry = new ToolRegistry().register(stubTool('bash', '运行命令'));
    const events: RuntimeEvent[] = [];

    const result = await runAgentTurn(
      {
        provider,
        system: '你是 modou',
        messages: [{ role: 'user', content: '跑个命令' }],
        tools: registry,
        options: { maxTurns: 2 },
      },
      (event) => {
        events.push(event);
      },
    );

    // 两轮请求都发出、断点 ① 每轮都在（第二轮的工具来自 toToolSet 缓存）
    expect(model.seenOptions).toHaveLength(2);
    expect(result.termination).toBe('end_turn');
    // 第一轮 usage 无缓存分项；第二轮 cacheRead 60 / noCache 20 → 累计 0.75
    expect(result.usage.cacheReadTokens).toBe(60);
    expect(result.usage.noCacheTokens).toBe(20);
    expect(result.usage.cacheHitRate).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// 真实端点冒烟（门控：openai-compat 重复请求；anthropic 为 opt-in）
// ---------------------------------------------------------------------------

const opencodeEnv = readOpencodeEnv();
const hasOpencodeConfig = opencodeEnv !== null;
/** 缓存 live 冒烟的显式 opt-in（ANTHROPIC_API_KEY 存在时才可能跑通）。 */
const liveCacheEnabled = process.env.MODOU_LIVE_CACHE === '1';

const LIVE_SYSTEM = '你是 modou，测试助手。';
const LIVE_TOOLS: ToolSet = {
  echo: tool({
    description: '回显输入',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
  }),
};

describe('真实端点缓存冒烟（G-0.7.0 前提：重复前缀成本下降）', () => {
  test.skipIf(!hasOpencodeConfig)(
    'openai-compat 重复请求：两次 usage 均上报，缓存分项存在时命中率可算',
    async () => {
      const provider = createOpenAICompatProvider({
        modelId: opencodeEnv!.deepseekModel,
        baseURL: opencodeEnv!.baseURL,
        apiKey: opencodeEnv!.apiKey,
      });

      for (let round = 0; round < 2; round += 1) {
        const events = await collect(provider, {
          system: LIVE_SYSTEM,
          tools: LIVE_TOOLS,
          messages: [{ role: 'user', content: '你好，重复一次' }],
        });
        const usageEvent = events.find((event) => event.type === 'usage');
        expect(usageEvent?.type).toBe('usage');
        if (usageEvent?.type === 'usage') {
          // OpenAI 兼容端点自动缓存：供应商上报 cached_tokens 时才计算命中率
          const { cacheReadTokens, noCacheTokens, cacheHitRate } =
            usageEvent.usage;
          if (cacheReadTokens !== undefined && noCacheTokens !== undefined) {
            const expected =
              cacheReadTokens / (cacheReadTokens + noCacheTokens);
            expect(cacheHitRate).toBe(expected);
          }
        }
      }
    },
    60_000,
  );

  test.skipIf(!hasOpencodeConfig || !liveCacheEnabled)(
    'anthropic 两连请求（opt-in MODOU_LIVE_CACHE=1）：第二轮 cacheRead 出现',
    async () => {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('MODOU_LIVE_CACHE=1 需要 ANTHROPIC_API_KEY');
      }
      const provider = createAnthropicProvider({
        modelId: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
      });

      const input: StreamChatInput = {
        system: LIVE_SYSTEM,
        tools: LIVE_TOOLS,
        messages: [{ role: 'user', content: '你好，重复一次' }],
      };
      // 首轮：写入缓存；第二轮：稳定前缀命中缓存 → cacheRead > 0
      await collect(provider, input);
      const second = await collect(provider, input);
      const usageEvent = second.find((event) => event.type === 'usage');
      expect(usageEvent?.type).toBe('usage');
      if (usageEvent?.type === 'usage') {
        expect(usageEvent.usage.cacheReadTokens).toBeGreaterThan(0);
      }
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// 辅助：收集流式事件（与契约测试同款）
// ---------------------------------------------------------------------------

async function collect(
  provider: {
    streamChat: (input: StreamChatInput) => AsyncIterable<StreamEvent>;
  },
  input: StreamChatInput,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.streamChat(input)) {
    events.push(event);
  }
  return events;
}
