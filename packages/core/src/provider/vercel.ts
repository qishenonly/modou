import { streamText } from 'ai';
import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  SystemModelMessage,
  ToolSet,
} from 'ai';
import type { ProviderCapabilities } from './capabilities';
import { ProviderError, normalizeProviderError } from './errors';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
  StreamFinishReason,
  TokenUsage,
} from './types';

/**
 * 模型构造工厂。
 *
 * 这是 T-011 接入新供应商的唯一挂点：给定 modelId，返回一个可被
 * `streamText` 消费的 AI SDK 语言模型（如 `@ai-sdk/anthropic` 提供的
 * `anthropic(...)` 结果）。本层不关心供应商差异，只做统一的流式转发、
 * 事件分发、usage 提取与错误归一。
 */
export type CreateModel = (modelId: string) => LanguageModel;

export interface VercelModelProviderOptions {
  /** 供应商 ID，如 `anthropic` / `openai-compat` */
  readonly id: string;
  /** 当前选用的模型 ID */
  readonly modelId: string;
  /** 该模型的能力描述 */
  readonly capabilities: ProviderCapabilities;
  /** 模型构造工厂 */
  readonly createModel: CreateModel;
}

/** AI SDK 的 FinishReason → 统一 StreamFinishReason。 */
const AI_SDK_REASON_TO_STREAM: Record<string, StreamFinishReason> = {
  stop: 'stop',
  length: 'length',
  'content-filter': 'content-filter',
  'tool-calls': 'tool_use',
  error: 'error',
  other: 'other',
};

function mapFinishReason(reason: string): StreamFinishReason {
  return AI_SDK_REASON_TO_STREAM[reason] ?? 'other';
}

/**
 * 缓存命中率（T-071）：cacheRead / (cacheRead + noCache)，0~1。
 *
 * 供应商上报了 cacheRead 与 noCache 两者（都非 undefined）且总和 > 0 时才
 * 可计算，否则返回 undefined（尽力而为，不因缺失字段破坏上报）。
 */
export function computeCacheHitRate(
  cacheRead: number | undefined,
  noCache: number | undefined,
): number | undefined {
  if (cacheRead === undefined || noCache === undefined) return undefined;
  const total = cacheRead + noCache;
  if (total <= 0) return undefined;
  return cacheRead / total;
}

/** AI SDK 的 LanguageModelUsage → 统一 TokenUsage（含缓存命中率，T-071）。 */
function toTokenUsage(usage: LanguageModelUsage): TokenUsage {
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens;
  const noCacheTokens = usage.inputTokenDetails?.noCacheTokens;
  const cacheHitRate = computeCacheHitRate(cacheReadTokens, noCacheTokens);
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    noCacheTokens,
    cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
    ...(cacheHitRate === undefined ? {} : { cacheHitRate }),
  };
}

// ---------------------------------------------------------------------------
// 缓存断点注入（design 002 §7.1 分段投影 + §8.1 能力描述；T-071）
//
// 002 7.1 把请求上下文切成稳定前缀（system + tools + instructions）、
// 半稳定（压缩摘要块）与易变区（历史 / 工具输出 / 当前输入），缓存断点打在
// 稳定前缀之后（断点 ①）与摘要块之后（断点 ②）。本层按供应商机制把断点
// 落到请求里：
//
// - 断点 ①（稳定前缀）：Anthropic 以 `cache_control: {type:'ephemeral'}`
//   标记一段前缀缓存。system + tools 在请求里排在 messages 之前，把断点打
//   在最后一个工具定义上即缓存整个稳定前缀；无工具时打在 system 上。
// - 断点 ②（半稳定摘要块）：压缩投影把摘要块作为一条 system 角色消息放进
//   messages（context/compact.ts 的 buildSummaryBlock），把断点打在这条
//   消息上。摘要变化只失效 ② 的缓存前缀，稳定前缀 ① 仍命中。
//
// 能力描述 `cacheBreakpoints=false` 的模型（如 OpenAI 兼容端点：自动缓存、
// 不支持显式断点）不注入任何 providerOptions。注入形态与 AI SDK v7 对齐：
// 在消息 / 工具 / system 上挂 `providerOptions.<sdkKey>.cacheControl`，
// 供应商适配层据此产出各自的缓存标记。
// ---------------------------------------------------------------------------

/** Anthropic 的临时缓存断点值（`cache_control: {type:'ephemeral'}`）。 */
const EPHEMERAL_CACHE: { readonly type: 'ephemeral' } = {
  type: 'ephemeral',
};

/**
 * provider 适配层 id → AI SDK 供应商的 providerOptions 键。
 *
 * 只有声明 `cacheBreakpoints: true` 的供应商才会命中注入（默认仅 anthropic）；
 * openai-compat 映射到 `openai`，其 @ai-sdk/openai 不支持显式断点，设置后
 * 会被适配层忽略（能力描述 `cacheBreakpoints` 缺省即 false，正常不注入）。
 * 未登记 id 回落为 id 本身（尽力而为，避免未知供应商被漏掉）。
 */
const PROVIDER_OPTIONS_KEY: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  'openai-compat': 'openai',
};

/** 取供应商 providerOptions 键（未登记时回落为 id 本身）。 */
function providerOptionsKey(id: string): string {
  return PROVIDER_OPTIONS_KEY[id] ?? id;
}

/** 在 system 上挂断点（无工具时的断点 ①）：system 转为 SystemModelMessage。 */
function systemWithBreakpoint(
  system: string,
  key: string,
): SystemModelMessage[] {
  return [
    {
      role: 'system',
      content: system,
      providerOptions: { [key]: { cacheControl: EPHEMERAL_CACHE } },
    },
  ];
}

/** 在最后一个工具定义上挂断点 ①（覆盖 system + 全部工具定义）。 */
function toolsWithBreakpoint(tools: ToolSet, key: string): ToolSet {
  const names = Object.keys(tools);
  if (names.length === 0) return tools;
  const lastName = names[names.length - 1];
  const last = tools[lastName];
  if (last === undefined) return tools;
  return {
    ...tools,
    [lastName]: {
      ...last,
      providerOptions: {
        ...last.providerOptions,
        [key]: { cacheControl: EPHEMERAL_CACHE },
      },
    },
  };
}

/**
 * 在 messages 中最后一条 system 角色消息上挂断点 ②（压缩摘要块）。
 *
 * 压缩投影（context/compact.ts）把摘要块作为 system 消息放在 messages 里
 * （allowSystemInMessages 放行）；任何其他 system 消息同样按「半稳定区」处理。
 * 没有 system 消息（未压缩 / 无摘要）时保持原数组不变。
 */
function messagesWithBreakpoint(
  messages: readonly ModelMessage[],
  key: string,
): ModelMessage[] {
  let lastSystemIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'system') lastSystemIndex = index;
  }
  if (lastSystemIndex < 0) return [...messages];
  return messages.map((message, index) =>
    index === lastSystemIndex
      ? {
          ...message,
          providerOptions: {
            ...message.providerOptions,
            [key]: { cacheControl: EPHEMERAL_CACHE },
          },
        }
      : message,
  );
}

/** 缓存断点注入的产物（streamChat 组装 streamText 入参用）。 */
export interface CacheBreakpointHints {
  /** 挂断点 ① 后的 system（无工具时为 SystemModelMessage 数组）。 */
  readonly system: string | SystemModelMessage[] | undefined;
  /** 挂断点 ① 后的工具集（最后一个工具带 providerOptions）。 */
  readonly tools: StreamChatInput['tools'];
  /** 挂断点 ② 后的消息（最后一条 system 消息带 providerOptions）。 */
  readonly messages: ModelMessage[];
}

/**
 * 为一次请求装配缓存断点（T-071；仅在能力描述 cacheBreakpoints=true 时调用）。
 *
 * - 断点 ①：有工具 → 打在最后一个工具定义上（缓存 system + 全部工具）；
 *   无工具 → 打在 system 上；
 * - 断点 ②：messages 里最后一条 system 角色消息（压缩摘要块）。
 *
 * 纯函数：不修改入参，返回全新对象。
 */
export function applyCacheBreakpoints(
  id: string,
  input: StreamChatInput,
): CacheBreakpointHints {
  const key = providerOptionsKey(id);
  const hasTools =
    input.tools !== undefined && Object.keys(input.tools).length > 0;

  // 断点 ① 落点：工具存在打在最后一个工具，否则打在 system（system 非空时）
  const system =
    !hasTools && input.system !== undefined && input.system.length > 0
      ? systemWithBreakpoint(input.system, key)
      : input.system;
  const tools = hasTools ? toolsWithBreakpoint(input.tools!, key) : input.tools;
  const messages = messagesWithBreakpoint(input.messages, key);
  return { system, tools, messages };
}

/** 流中 abort 部分的 reason 字符串 → 归一错误（timeout 需要区分开）。 */
function abortPartToError(reason: string | undefined): ProviderError {
  if (reason !== undefined && /timeout/i.test(reason)) {
    return new ProviderError({
      kind: 'timeout',
      message: `请求超时（${reason}）`,
    });
  }
  return new ProviderError({ kind: 'aborted', message: '请求已被中断' });
}

/**
 * 返回 buffer 中可作为 marker 前缀保留的尾部片段。
 *
 * 用于跨 delta 的标签切分：`abc<thi` + `nk>` 应当被正确识别为 `<think>`。
 */
function keepTagPrefix(buffer: string, marker: string): string {
  const max = Math.min(buffer.length, marker.length);
  for (let i = max; i >= 1; i--) {
    if (buffer.endsWith(marker.slice(0, i))) {
      return buffer.slice(buffer.length - i);
    }
  }
  return '';
}

/**
 * `<think>...</think>` 标签剥离器（thinking === 'tagged' 的模型用）。
 *
 * 这类模型把推理过程混在正文里；本类按能力描述做吸收：跨多个 text delta
 * 正确识别完整 think 块并丢弃，只把块外的可见文本交给 text_delta 事件。
 */
class TaggedThinkStripper {
  private buffer = '';
  private inThink = false;

  /** 接收一段文本增量，返回剥离 think 块后的可见文本。 */
  push(delta: string): string {
    this.buffer += delta;
    let out = '';

    while (true) {
      if (!this.inThink) {
        const idx = this.buffer.indexOf('<think>');
        if (idx === -1) {
          // 没有 think 块：保留可能是标签前缀的尾部，其余全部输出
          const tail = keepTagPrefix(this.buffer, '<think>');
          out += this.buffer.slice(0, this.buffer.length - tail.length);
          this.buffer = tail;
          break;
        }
        out += this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + '<think>'.length);
        this.inThink = true;
        continue;
      }

      const idx = this.buffer.indexOf('</think>');
      if (idx === -1) {
        // think 内容直接丢弃；同样保留可能是闭合标签前缀的尾部
        this.buffer = keepTagPrefix(this.buffer, '</think>');
        break;
      }
      this.buffer = this.buffer.slice(idx + '</think>'.length);
      this.inThink = false;
    }

    return out;
  }
}

/**
 * 基于 Vercel AI SDK 的通用 ModelProvider 骨架。
 *
 * 职责：统一流式转发（text_delta / thinking_delta / tool_use / usage /
 * finish）、按能力描述吸收差异（tagged 推理剥标签）、错误归一、可中断。
 * T-011 接入新供应商只需提供 `createModel` 与能力描述。
 */
export class VercelModelProvider implements ModelProvider {
  readonly id: string;
  readonly modelId: string;
  readonly capabilities: ProviderCapabilities;
  private readonly createModel: CreateModel;
  private readonly thinkStripper: TaggedThinkStripper | null;

  constructor(options: VercelModelProviderOptions) {
    this.id = options.id;
    this.modelId = options.modelId;
    this.capabilities = options.capabilities;
    this.createModel = options.createModel;
    this.thinkStripper =
      options.capabilities.thinking === 'tagged'
        ? new TaggedThinkStripper()
        : null;
  }

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    // T-071 缓存断点：能力描述 cacheBreakpoints=true 时按 002 7.1 分段装配
    // （断点 ① 稳定前缀 + 断点 ② 摘要块）；false 的模型不设（OpenAI 兼容端点
    // 走自动缓存，无需显式断点）。注入对调用方透明——loop 只传
    // system / messages / tools，不感知供应商机制（002 8.1 能力描述）。
    const hints = this.capabilities.cacheBreakpoints
      ? applyCacheBreakpoints(this.id, input)
      : null;

    const result = streamText({
      model: this.createModel(this.modelId),
      system: hints?.system ?? input.system,
      messages: hints?.messages ?? input.messages,
      // T-070 /compact：压缩投影会把摘要块作为 system 角色消息放进 messages
      // 数组（早期轮次的占位，见 context/compact.ts）。AI SDK 默认不允许
      // system 消息出现在 messages 中，这里显式放行；供应商适配层负责把
      // system 消息转换为各自的 system prompt 语义（Anthropic / OpenAI 均支持）。
      allowSystemInMessages: true,
      // 工具定义随请求发给模型（注册表缺失时不传——模型没有工具可用）。
      ...((hints?.tools ?? input.tools) === undefined
        ? {}
        : { tools: hints?.tools ?? input.tools }),
      abortSignal: input.abortSignal,
      maxRetries: input.maxRetries ?? 2,
      // 错误统一归一后由本层抛出、loop 负责展示；抑制 SDK 默认的 console.error 噪音
      onError: () => {},
    });

    let finished = false;
    try {
      for await (const part of result.stream) {
        switch (part.type) {
          case 'text-delta': {
            const delta =
              this.thinkStripper === null
                ? part.text
                : this.thinkStripper.push(part.text);
            if (delta.length > 0) {
              yield { type: 'text_delta', delta };
            }
            break;
          }
          case 'reasoning-delta':
            // 能力描述门控：声明 thinking: 'none' 的模型即使吐出推理增量也不外泄
            if (this.capabilities.thinking !== 'none') {
              yield { type: 'thinking_delta', delta: part.text };
            }
            break;
          case 'tool-call':
            yield {
              type: 'tool_use',
              id: part.toolCallId,
              name: part.toolName,
              input: part.input,
            };
            break;
          case 'finish':
            finished = true;
            yield { type: 'usage', usage: toTokenUsage(part.totalUsage) };
            yield {
              type: 'finish',
              reason: mapFinishReason(part.finishReason),
            };
            break;
          case 'abort':
            // 用户中断或内部超时：统一抛出可判定的 ProviderError
            throw abortPartToError(part.reason);
          case 'error':
            // 流中出现的非致命错误（如工具解析失败），同样归一后抛出
            throw normalizeProviderError(part.error);
          default:
            // 其余部分（start-step / finish-step / source / file 等）暂不透出
            break;
        }
      }
    } catch (error) {
      // 抛出的任何原始错误（网络错误 / APICallError / 超时等）都归一
      throw normalizeProviderError(error);
    } finally {
      // 中途退出（消费者 break / 抛错）时取消底层流，避免悬挂
      if (!finished) {
        await result.stream.cancel().catch(() => {});
      }
    }
  }
}
