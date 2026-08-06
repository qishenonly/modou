import { describe, expect, test } from 'bun:test';
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import {
  APICallError,
  LoadAPIKeyError,
  jsonSchema,
  simulateReadableStream,
  tool,
} from 'ai';
import type { ProviderCapabilities } from './capabilities';
import { normalizeProviderError, ProviderError } from './errors';
import type { ModelProvider, StreamChatInput, StreamEvent } from './types';
import { VercelModelProvider } from './vercel';

// ---------------------------------------------------------------------------
// 测试替身：一个极简的 AI SDK v3 假模型，用 simulateReadableStream 模拟流式输出。
// 用 v3 而非 v2 是为了贴近 T-011 真实供应商包返回的模型形态，也避免
// AI SDK 对 v2 兼容模式打印的告警噪音。
// ---------------------------------------------------------------------------

const noDelay = { _internal: { delay: () => Promise.resolve() } };

function v3Usage(
  overrides: {
    inputTotal?: number;
    outputTotal?: number;
    cacheRead?: number;
  } = {},
): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: overrides.inputTotal ?? 0,
      noCache: undefined,
      cacheRead: overrides.cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: overrides.outputTotal ?? 0,
      text: undefined,
      reasoning: undefined,
    },
  };
}

const STOP_REASON = { unified: 'stop' as const, raw: undefined };

/** 构造一个固定输出 parts 的假模型。 */
function fakeModel(parts: LanguageModelV3StreamPart[]): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [],
      finishReason: STOP_REASON,
      usage: v3Usage(),
      warnings: [],
    }),
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: parts, ...noDelay }),
    }),
  };
}

/** 构造一个 doStream 抛错的假模型（模拟 429 / 5xx 等供应商错误）。 */
function throwingModel(error: unknown): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [],
      finishReason: STOP_REASON,
      usage: v3Usage(),
      warnings: [],
    }),
    doStream: async () => {
      throw error;
    },
  };
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

function makeProvider(
  model: LanguageModelV3,
  overrides: Partial<ProviderCapabilities> = {},
): VercelModelProvider {
  return new VercelModelProvider({
    id: 'test',
    modelId: 'fake-model',
    capabilities: { ...DEFAULT_CAPABILITIES, ...overrides },
    createModel: () => model,
  });
}

/** 把流式事件全部收集成数组。 */
async function collect(
  provider: ModelProvider,
  input: StreamChatInput,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.streamChat(input)) {
    events.push(event);
  }
  return events;
}

const chatInput = {
  messages: [{ role: 'user' as const, content: '你好' }],
};

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('VercelModelProvider（基于 AI SDK v7 的通用骨架）', () => {
  test('流式 text 事件逐个产出，usage 被提取（含缓存命中）', async () => {
    const provider = makeProvider(
      fakeModel([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: '你' },
        { type: 'text-delta', id: 'text-1', delta: '好' },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          usage: v3Usage({ inputTotal: 12, outputTotal: 5, cacheRead: 3 }),
          finishReason: STOP_REASON,
        },
      ]),
    );

    const events = await collect(provider, chatInput);

    expect(events).toEqual([
      { type: 'text_delta', delta: '你' },
      { type: 'text_delta', delta: '好' },
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          noCacheTokens: undefined,
          cacheReadTokens: 3,
          cacheWriteTokens: undefined,
        },
      },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  test('tool_use 停止能透出：模型返回工具调用时产出 tool_use 事件', async () => {
    const provider = makeProvider(
      fakeModel([
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'bash',
          input: '{"cmd":"ls"}',
        },
        {
          type: 'finish',
          usage: v3Usage({ inputTotal: 20, outputTotal: 1 }),
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        },
      ]),
    );

    const events = await collect(provider, {
      ...chatInput,
      tools: {
        bash: tool({
          description: '运行命令',
          inputSchema: jsonSchema({
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd'],
          }),
        }),
      },
    });

    expect(events).toContainEqual({
      type: 'tool_use',
      id: 'call-1',
      name: 'bash',
      input: { cmd: 'ls' },
    });
    expect(events).toContainEqual({ type: 'finish', reason: 'tool_use' });
  });

  test('AbortSignal 中断能停下：预中断的信号导致抛出 aborted', async () => {
    const provider = makeProvider(
      fakeModel([
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: '你' },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          usage: v3Usage({ inputTotal: 1, outputTotal: 1 }),
          finishReason: STOP_REASON,
        },
      ]),
    );

    const controller = new AbortController();
    controller.abort();

    const promise = collect(provider, {
      ...chatInput,
      abortSignal: controller.signal,
    });
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
  });

  test('错误归一：供应商抛 429 被分类为 rate_limited（可重试）', async () => {
    const provider = makeProvider(
      throwingModel(
        new APICallError({
          message: 'rate limited',
          url: 'https://example.test/v1/chat',
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: true,
        }),
      ),
    );

    const promise = collect(provider, { ...chatInput, maxRetries: 0 });
    await expect(promise).rejects.toMatchObject({
      kind: 'rate_limited',
      statusCode: 429,
      retryable: true,
    });
  });

  test('thinking === tagged 时剥离 <think> 标签，正文不被污染', async () => {
    const provider = makeProvider(
      fakeModel([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: '先思考<think>推理过程…' },
        { type: 'text-delta', id: 'text-1', delta: '另一段推理</think>' },
        { type: 'text-delta', id: 'text-1', delta: '，结论：好' },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          usage: v3Usage({ inputTotal: 30, outputTotal: 8 }),
          finishReason: STOP_REASON,
        },
      ]),
      { thinking: 'tagged' },
    );

    const events = await collect(provider, chatInput);

    const text = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => event.delta)
      .join('');
    expect(text).toBe('先思考，结论：好');
    expect(events.some((event) => event.type === 'thinking_delta')).toBe(false);
  });

  test('createModel 以供应商实例的 modelId 被调用', async () => {
    const calledWith: string[] = [];
    const provider = new VercelModelProvider({
      id: 'openai-compat',
      modelId: 'deepseek-v4-flash',
      capabilities: DEFAULT_CAPABILITIES,
      createModel: (modelId) => {
        calledWith.push(modelId);
        return fakeModel([
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'hi' },
          { type: 'text-end', id: 't' },
          {
            type: 'finish',
            usage: v3Usage({ inputTotal: 1, outputTotal: 1 }),
            finishReason: STOP_REASON,
          },
        ]);
      },
    });

    await collect(provider, chatInput);
    expect(calledWith).toEqual(['deepseek-v4-flash']);
  });
});

describe('normalizeProviderError（错误归一）', () => {
  test('429 → rate_limited，可重试', () => {
    const error = normalizeProviderError(
      new APICallError({
        message: 'rate limited',
        url: 'https://example.test',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      }),
    );
    expect(error).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      statusCode: 429,
    });
  });

  test('5xx → server_error，可重试', () => {
    const error = normalizeProviderError(
      new APICallError({
        message: 'internal error',
        url: 'https://example.test',
        requestBodyValues: {},
        statusCode: 502,
        isRetryable: true,
      }),
    );
    expect(error).toMatchObject({
      kind: 'server_error',
      retryable: true,
      statusCode: 502,
    });
  });

  test('401 → invalid_api_key', () => {
    const error = normalizeProviderError(
      new APICallError({
        message: 'unauthorized',
        url: 'https://example.test',
        requestBodyValues: {},
        statusCode: 401,
      }),
    );
    expect(error).toMatchObject({ kind: 'invalid_api_key', retryable: false });
  });

  test('缺少 API Key → invalid_api_key', () => {
    const error = normalizeProviderError(
      new LoadAPIKeyError({ message: 'missing key' }),
    );
    expect(error).toMatchObject({ kind: 'invalid_api_key' });
  });

  test('TimeoutError → timeout，可重试', () => {
    const timeoutError = Object.assign(
      new Error('timeout of 10000ms exceeded'),
      {
        name: 'TimeoutError',
      },
    );
    const error = normalizeProviderError(timeoutError);
    expect(error).toMatchObject({ kind: 'timeout', retryable: true });
  });

  test('AbortError → aborted', () => {
    const abortError = Object.assign(new Error('The operation was aborted.'), {
      name: 'AbortError',
    });
    const error = normalizeProviderError(abortError);
    expect(error).toMatchObject({ kind: 'aborted', retryable: false });
  });

  test('未知错误 → unknown，且保留 cause', () => {
    const cause = new Error('something weird');
    const error = normalizeProviderError(cause);
    expect(error).toMatchObject({ kind: 'unknown', cause });
  });

  test('已归一错误原样返回', () => {
    const original = new ProviderError({
      kind: 'not_found',
      message: '模型不存在',
    });
    expect(normalizeProviderError(original)).toBe(original);
  });
});
