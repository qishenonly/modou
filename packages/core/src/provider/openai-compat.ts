import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import type { ProviderCapabilities } from './capabilities';
import type { ModelProvider } from './types';
import { VercelModelProvider } from './vercel';
import type { CreateModel } from './vercel';

/**
 * openai-compat 默认能力描述（保守取值）。
 *
 * 这个适配器统一服务 OpenAI / DeepSeek / Kimi / Qwen / GLM / Ollama：
 * 差别只在 baseURL / apiKey / modelId / capabilities，全部由配置给出，
 * 代码里不写死任何供应商分支。默认值按「现代 OpenAI 兼容端点」取；
 * 国产模型的差异（strictJsonArgs: false、thinking: 'tagged' 等）由
 * 配置显式覆盖。
 */
export const OPENAI_COMPAT_DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: true,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

// ---------------------------------------------------------------------------
// 宽松工具参数 JSON 容错（strictJsonArgs === false 的国产模型用）
// ---------------------------------------------------------------------------

/**
 * 宽松解析结果：成功给值，失败给原因。
 */
export type LenientParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

function tryParseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** 剥离一层 markdown 代码围栏（```json ... ``` 或 ``` ... ```）。 */
function stripMarkdownFence(text: string): string {
  const match = /^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```\s*$/.exec(
    text,
  );
  if (match === null) return text;
  const body = match[1] ?? '';
  return body.trim();
}

/**
 * 去掉尾随逗号与孤立前导逗号 —— 国产模型常见的两种不合规写法：
 * `{"cmd":"ls",}`、`[1,2,]`、`{,"cmd":"ls"}`。
 */
function stripCommaNoise(text: string): string {
  return text
    .replace(/,(\s*[}\]])/g, '$1') // 尾随逗号：{... , } / [... , ]
    .replace(/([{\[]\s*),/g, '$1'); // 前导逗号：{ ,"a":1 }
}

/** 截取最外层 {…} / […] 主体，跳过多余的前缀后缀（如自然语言包裹）。 */
function extractOuterJson(text: string): string | null {
  const firstObject = text.indexOf('{');
  const firstArray = text.indexOf('[');
  const candidates = [firstObject, firstArray].filter((index) => index >= 0);
  if (candidates.length === 0) return null;
  const start = Math.min(...candidates);
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  if (end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * 尽力解析工具参数 JSON。
 *
 * 合规输入零开销直达（第一步即成功）；不合规输入依次尝试：
 * ① 剥离 markdown 代码围栏 → ② 去尾随/前导逗号 → ③ 截取最外层主体。
 * 全部失败返回失败原因，由上层决定走错误归一路径。
 */
export function parseToolArgsLenient(raw: string): LenientParseResult {
  // 非字符串（如 SDK 已解析的对象）不做处理，直接视为成功
  if (typeof raw !== 'string') return { ok: true, value: raw };

  let text = raw.trim();
  if (text === '') {
    return { ok: false, reason: '工具参数为空字符串' };
  }

  // ① 严格解析优先
  const strict = tryParseJson(text);
  if (strict.ok) return { ok: true, value: strict.value };

  // ② 剥离 markdown 代码围栏
  const fenced = stripMarkdownFence(text);
  if (fenced !== text) {
    const retry = tryParseJson(fenced);
    if (retry.ok) return { ok: true, value: retry.value };
    text = fenced;
  }

  // ③ 去尾随/前导逗号
  const deNoised = stripCommaNoise(text);
  if (deNoised !== text) {
    const retry = tryParseJson(deNoised);
    if (retry.ok) return { ok: true, value: retry.value };
    text = deNoised;
  }

  // ④ 截取最外层对象/数组主体
  const body = extractOuterJson(text);
  if (body !== null) {
    const retry = tryParseJson(body);
    if (retry.ok) return { ok: true, value: retry.value };
  }

  return { ok: false, reason: '尽力解析后仍不是合法 JSON' };
}

/** 类型守卫：v4 语言模型（宽松参数包装只作用于 v4）。 */
function isV4LanguageModel(model: LanguageModel): model is LanguageModelV4 {
  return (
    typeof model === 'object' &&
    model !== null &&
    'specificationVersion' in model &&
    (model as { specificationVersion?: unknown }).specificationVersion === 'v4'
  );
}

export interface LenientArgsModelOptions {
  /** 诊断日志中标识供应商实例，如 `openai-compat`。 */
  readonly providerId: string;
}

/**
 * 宽松工具参数模型包装器（strictJsonArgs === false 的兼容端点用）。
 *
 * 拦截 v4 模型 doStream / doGenerate 结果里的 tool-call 部分：其 input 是
 * 供应商原文（字符串）。严格 JSON.parse 失败时做尽力恢复，恢复成功则把
 * 参数规整成合法 JSON 字符串交回 AI SDK —— 否则 SDK 的 safeParseJSON 会以
 * InvalidToolInputError 拒绝整轮；恢复失败则保留原文，让上层走错误归一。
 *
 * 容错成功 / 失败都通过 console.warn 打日志，便于在真实调用里观测国产
 * 模型的不合规参数有多频繁，从而决定是否值得在 0.1.0 之后反馈给厂商。
 */
export class LenientToolArgsModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: LanguageModelV4['supportedUrls'];
  private readonly inner: LanguageModelV4;
  private readonly providerId: string;

  constructor(inner: LanguageModelV4, options: LenientArgsModelOptions) {
    this.inner = inner;
    this.provider = inner.provider;
    this.modelId = inner.modelId;
    this.supportedUrls = inner.supportedUrls;
    this.providerId = options.providerId;
  }

  async doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    const result = await this.inner.doGenerate(options);
    return {
      ...result,
      content: result.content.map((part) => this.fixToolCallContent(part)),
    };
  }

  async doStream(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    const result = await this.inner.doStream(options);
    const stream = result.stream.pipeThrough(
      new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>(
        {
          transform: (part, controller) => {
            controller.enqueue(this.fixToolCallPart(part));
          },
        },
      ),
    );
    return { ...result, stream };
  }

  /** 把工具参数规整成合法 JSON 字符串；恢复失败时原样返回。 */
  private normalizeToolArgs(raw: string, toolName: string): string {
    const result = parseToolArgsLenient(raw);
    if (result.ok) {
      const normalized = JSON.stringify(result.value);
      if (normalized === undefined) {
        console.warn(
          `[provider:${this.providerId}] 工具参数 JSON 容错失败（${toolName}）：解析结果无法序列化`,
        );
        return raw;
      }
      console.warn(
        `[provider:${this.providerId}] 工具参数 JSON 容错成功（${toolName}），已规整为合法 JSON`,
      );
      return normalized;
    }
    console.warn(
      `[provider:${this.providerId}] 工具参数 JSON 容错失败（${toolName}）：${result.reason}，保留原文交给错误归一`,
    );
    return raw;
  }

  private fixToolCallPart(
    part: LanguageModelV4StreamPart,
  ): LanguageModelV4StreamPart {
    if (part.type !== 'tool-call' || typeof part.input !== 'string')
      return part;
    return {
      ...part,
      input: this.normalizeToolArgs(part.input, part.toolName),
    };
  }

  private fixToolCallContent(
    part: LanguageModelV4Content,
  ): LanguageModelV4Content {
    if (part.type !== 'tool-call' || typeof part.input !== 'string')
      return part;
    return {
      ...part,
      input: this.normalizeToolArgs(part.input, part.toolName),
    };
  }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export interface OpenAICompatProviderConfig {
  /** 模型 ID，如 `deepseek-v4-flash` / `qwen2.5-coder` / `llama3.1`。 */
  readonly modelId: string;
  /** 端点前缀；缺省由 @ai-sdk/openai 回落 OPENAI_BASE_URL，再缺省官方地址。 */
  readonly baseURL?: string;
  /**
   * API Key；缺省由 @ai-sdk/openai 回落 OPENAI_API_KEY。
   * 本地免鉴权端点（如 Ollama 的 http://localhost:11434/v1）需要填一个
   * 非空占位值（惯例是 `ollama`），否则请求会以 invalid_api_key 失败。
   */
  readonly apiKey?: string;
  /** 能力描述；缺省用保守默认值，国产模型差异由调用方显式覆盖。 */
  readonly capabilities?: ProviderCapabilities;
  /**
   * 模型构造注入口（测试专用）：注入自定义 createModel 后，
   * 离线契约测试可以在不访问外网的情况下跑通整个工厂。
   */
  readonly createModel?: CreateModel;
}

/**
 * 构造 OpenAI 兼容供应商实例（DeepSeek / Kimi / Qwen / GLM / Ollama /
 * OpenAI 共用这一个工厂）。
 *
 * 适配要点：
 * 1. 一律走 Chat Completions 风格 —— 必须用 `provider.chat(modelId)`，
 *    而不是默认的 Responses API（默认调用会收到 Chat Completions 流并报错）；
 * 2. `strictJsonArgs === false` 时把模型包一层 LenientToolArgsModel，
 *    兑现国产模型的宽松参数 JSON 容错；
 * 3. 供应商差异（baseURL / apiKey / modelId / capabilities）全部来自配置，
 *    本文件不写死任何供应商分支。
 */
export function createOpenAICompatProvider(
  options: OpenAICompatProviderConfig,
): ModelProvider {
  const capabilities =
    options.capabilities ?? OPENAI_COMPAT_DEFAULT_CAPABILITIES;

  const createModel: CreateModel =
    options.createModel ??
    ((modelId) => {
      const provider = createOpenAI({
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      });
      return provider.chat(modelId);
    });

  // strictJsonArgs === false 的模型（国产端点）：包一层宽松参数解析
  const wrapped: CreateModel = capabilities.strictJsonArgs
    ? createModel
    : (modelId) => {
        const model = createModel(modelId);
        // 只包 v4 模型；旧规范模型（v2/v3）原样透传
        return isV4LanguageModel(model)
          ? new LenientToolArgsModel(model, { providerId: 'openai-compat' })
          : model;
      };

  return new VercelModelProvider({
    id: 'openai-compat',
    modelId: options.modelId,
    capabilities,
    createModel: wrapped,
  });
}
