import { describe, expect, test } from 'bun:test';
import { APICallError, jsonSchema, simulateReadableStream, tool } from 'ai';
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import {
  ANTHROPIC_DEFAULT_CAPABILITIES,
  createAnthropicProvider,
} from '../anthropic';
import {
  createOpenAICompatProvider,
  OPENAI_COMPAT_DEFAULT_CAPABILITIES,
  parseToolArgsLenient,
} from '../openai-compat';
import type { ProviderCapabilities } from '../capabilities';
import type { ModelProvider, StreamChatInput } from '../types';
import { collect, runContractTests } from './contract.test';

// ---------------------------------------------------------------------------
// 测试替身：极简 AI SDK v4 假模型（与真实 @ai-sdk/* 供应商包返回的模型
// 同规范版本），用 simulateReadableStream 模拟流式输出，全程不碰外网。
// ---------------------------------------------------------------------------

const noDelay = {
  _internal: { delay: () => Promise.resolve() },
  initialDelayInMs: 0,
  chunkDelayInMs: 0,
};

function v4Usage(
  overrides: {
    inputTotal?: number;
    outputTotal?: number;
    cacheRead?: number;
  } = {},
): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: overrides.inputTotal ?? 7,
      noCache: undefined,
      cacheRead: overrides.cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: overrides.outputTotal ?? 3,
      text: undefined,
      reasoning: undefined,
    },
  };
}

const STOP_REASON = { unified: 'stop' as const, raw: undefined };

/** 构造一个固定输出 parts 的 v4 假模型。 */
function fakeV4Model(
  parts: LanguageModelV4StreamPart[],
  options: { throwOnStream?: boolean } = {},
): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'fake-v4',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [],
      finishReason: STOP_REASON,
      usage: v4Usage(),
      warnings: [],
    }),
    doStream: async () => {
      if (options.throwOnStream) {
        throw new APICallError({
          message: 'rate limited',
          url: 'https://example.test/v1/chat/completions',
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: true,
        });
      }
      return { stream: simulateReadableStream({ chunks: parts, ...noDelay }) };
    },
  };
}

/** 一段标准文本流式输出 + usage + finish。 */
const TEXT_PARTS: LanguageModelV4StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: '你' },
  { type: 'text-delta', id: 't1', delta: '好' },
  { type: 'text-end', id: 't1' },
  {
    type: 'finish',
    usage: v4Usage({ inputTotal: 12, outputTotal: 5, cacheRead: 3 }),
    finishReason: STOP_REASON,
  },
];

/** 国产模型形态的能力描述（strictJsonArgs: false 触发宽松容错路径）。 */
const DOMESTIC_LIKE: ProviderCapabilities = {
  ...OPENAI_COMPAT_DEFAULT_CAPABILITIES,
  strictJsonArgs: false,
  thinking: 'none',
};

const CHAT_INPUT: StreamChatInput = {
  messages: [{ role: 'user' as const, content: '你好' }],
};

// ---------------------------------------------------------------------------
// 离线适配器：走真实工厂 + 注入 stub 模型，契约测试在无 API Key 的
// CI 里也能跑（不访问外网）。
// ---------------------------------------------------------------------------

const anthropicOffline = createAnthropicProvider({
  modelId: 'claude-test',
  createModel: () => fakeV4Model(TEXT_PARTS),
});
const anthropicOffline429 = createAnthropicProvider({
  modelId: 'claude-test',
  createModel: () => fakeV4Model([], { throwOnStream: true }),
});

const compatOffline = createOpenAICompatProvider({
  modelId: 'deepseek-test',
  capabilities: DOMESTIC_LIKE,
  createModel: () => fakeV4Model(TEXT_PARTS),
});
const compatOffline429 = createOpenAICompatProvider({
  modelId: 'deepseek-test',
  capabilities: DOMESTIC_LIKE,
  createModel: () => fakeV4Model([], { throwOnStream: true }),
});

runContractTests('anthropic 适配器（离线 stub）', {
  provider: anthropicOffline,
  error429Provider: anthropicOffline429,
});

runContractTests('openai-compat 适配器（离线 stub，国产形态）', {
  provider: compatOffline,
  error429Provider: compatOffline429,
});

// ---------------------------------------------------------------------------
// 宽松工具参数 JSON 容错：单元用例 + 端到端用例
// ---------------------------------------------------------------------------

describe('parseToolArgsLenient（宽松参数 JSON 容错）', () => {
  test('严格合法输入直接通过，零开销', () => {
    expect(parseToolArgsLenient('{"cmd":"ls"}')).toEqual({
      ok: true,
      value: { cmd: 'ls' },
    });
  });

  test('剥离 markdown 代码围栏', () => {
    expect(parseToolArgsLenient('```json\n{"cmd":"ls"}\n```')).toEqual({
      ok: true,
      value: { cmd: 'ls' },
    });
    expect(parseToolArgsLenient('```\n{"cmd":"ls"}\n```')).toEqual({
      ok: true,
      value: { cmd: 'ls' },
    });
  });

  test('去掉尾随逗号与前导逗号', () => {
    expect(parseToolArgsLenient('{"cmd":"ls",}')).toEqual({
      ok: true,
      value: { cmd: 'ls' },
    });
    expect(parseToolArgsLenient('[1,2,]')).toEqual({ ok: true, value: [1, 2] });
    expect(parseToolArgsLenient('{,"cmd":"ls"}')).toEqual({
      ok: true,
      value: { cmd: 'ls' },
    });
  });

  test('截取最外层主体（去除自然语言包裹）', () => {
    expect(parseToolArgsLenient('参数是 {"cmd":"ls"} 请执行')).toEqual({
      ok: true,
      value: { cmd: 'ls' },
    });
  });

  test('无法恢复时返回失败原因', () => {
    const result = parseToolArgsLenient('{{{');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test('非字符串输入（SDK 已解析的对象）原样通过', () => {
    const input = { cmd: 'ls' } as unknown as string;
    expect(parseToolArgsLenient(input)).toEqual({ ok: true, value: input });
  });
});

describe('openai-compat 宽松工具参数容错（端到端，经工厂 + VercelModelProvider）', () => {
  const BASH_TOOL = {
    bash: tool({
      description: '运行 shell 命令',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { cmd: { type: 'string' } },
        required: ['cmd'],
      }),
    }),
  };

  const TOOL_CALL_PARTS: LanguageModelV4StreamPart[] = [
    {
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'bash',
      input: '{"cmd":"ls",}', // 带尾随逗号的不合规参数
    },
    {
      type: 'finish',
      usage: v4Usage({ inputTotal: 20, outputTotal: 1 }),
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    },
  ];

  test('strictJsonArgs=false：不合规参数被恢复成 tool_use', async () => {
    const provider = createOpenAICompatProvider({
      modelId: 'deepseek-test',
      capabilities: DOMESTIC_LIKE,
      createModel: () => fakeV4Model(TOOL_CALL_PARTS),
    });

    const events = await collect(provider, {
      ...CHAT_INPUT,
      tools: BASH_TOOL,
    });

    expect(events).toContainEqual({
      type: 'tool_use',
      id: 'call-1',
      name: 'bash',
      input: { cmd: 'ls' },
    });
    expect(events).toContainEqual({ type: 'finish', reason: 'tool_use' });
  });

  test('strictJsonArgs=true：不合规参数不被容错，原文透传', async () => {
    const provider = createOpenAICompatProvider({
      modelId: 'openai-test',
      capabilities: OPENAI_COMPAT_DEFAULT_CAPABILITIES, // strictJsonArgs: true
      createModel: () => fakeV4Model(TOOL_CALL_PARTS),
    });

    const events = await collect(provider, {
      ...CHAT_INPUT,
      tools: BASH_TOOL,
    });

    // ai@7 对非法工具参数不抛错：tool-call 带着原文透传（输入未被解析）。
    // 与上面 strictJsonArgs=false 的「恢复成对象」形成对照组 —— 差异正是
    // 能力描述里的 strictJsonArgs，而不是某个适配器写了 if 分支。
    expect(events).toContainEqual({
      type: 'tool_use',
      id: 'call-1',
      name: 'bash',
      input: '{"cmd":"ls",}',
    });
  });
});

// ---------------------------------------------------------------------------
// 工厂装配冒烟：实例元数据与 createModel 注入口行为
// ---------------------------------------------------------------------------

describe('供应商工厂装配', () => {
  test('anthropic 工厂默认能力描述为 Claude 出厂值', () => {
    const provider = createAnthropicProvider({
      modelId: 'claude-sonnet-4-5',
      createModel: () => fakeV4Model([]),
    });
    expect(provider.id).toBe('anthropic');
    expect(provider.modelId).toBe('claude-sonnet-4-5');
    expect(provider.capabilities).toEqual(ANTHROPIC_DEFAULT_CAPABILITIES);
  });

  test('openai-compat 工厂透传配置的能力描述', () => {
    const provider = createOpenAICompatProvider({
      modelId: 'deepseek-test',
      capabilities: DOMESTIC_LIKE,
      createModel: () => fakeV4Model([]),
    });
    expect(provider.id).toBe('openai-compat');
    expect(provider.capabilities).toEqual(DOMESTIC_LIKE);
    expect(provider.capabilities.strictJsonArgs).toBe(false);
  });

  test('createModel 以供应商实例的 modelId 被调用', async () => {
    const calledWith: string[] = [];
    const provider: ModelProvider = createOpenAICompatProvider({
      modelId: 'deepseek-v4-flash',
      capabilities: DOMESTIC_LIKE,
      createModel: (modelId) => {
        calledWith.push(modelId);
        return fakeV4Model(TEXT_PARTS);
      },
    });

    await collect(provider, CHAT_INPUT);
    expect(calledWith).toEqual(['deepseek-v4-flash']);
  });
});
