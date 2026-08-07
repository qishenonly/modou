import { streamText } from 'ai';
import type { LanguageModel, LanguageModelUsage } from 'ai';
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

/** AI SDK 的 LanguageModelUsage → 统一 TokenUsage。 */
function toTokenUsage(usage: LanguageModelUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    noCacheTokens: usage.inputTokenDetails?.noCacheTokens,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
  };
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
    const result = streamText({
      model: this.createModel(this.modelId),
      system: input.system,
      messages: input.messages,
      // T-070 /compact：压缩投影会把摘要块作为 system 角色消息放进 messages
      // 数组（早期轮次的占位，见 context/compact.ts）。AI SDK 默认不允许
      // system 消息出现在 messages 中，这里显式放行；供应商适配层负责把
      // system 消息转换为各自的 system prompt 语义（Anthropic / OpenAI 均支持）。
      allowSystemInMessages: true,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
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
