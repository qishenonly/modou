import type { ModelMessage, ToolSet } from 'ai';
import type { ProviderCapabilities } from './capabilities';

/**
 * 一次模型请求的 token 用量。
 *
 * 与 AI SDK 的 LanguageModelUsage 对齐；缓存命中相关字段「尽力而为」，
 * 供应商未上报时为 undefined。
 */
export interface TokenUsage {
  /** 输入（prompt）token 数（供应商未上报时为 undefined） */
  readonly inputTokens?: number;
  /** 输出（completion）token 数（供应商未上报时为 undefined） */
  readonly outputTokens?: number;
  /** 未命中缓存的输入 token 数 */
  readonly noCacheTokens?: number;
  /** 缓存命中的输入 token 数 */
  readonly cacheReadTokens?: number;
  /** 写入缓存的输入 token 数 */
  readonly cacheWriteTokens?: number;
}

/**
 * 本轮生成的终止原因（统一形态）。
 *
 * 供应商的原始 finishReason（如 AI SDK 的 `tool-calls`）已在这里归一，
 * `Runtime` 不需要感知供应商拼写差异。
 */
export type StreamFinishReason =
  'stop' | 'length' | 'content-filter' | 'tool_use' | 'error' | 'other';

/**
 * Provider 层事件分发形态。
 *
 * 0.1.0 没有工具，但 `tool_use` 通道先预留：loop 驱动 `while(tool_use)` 时
 * 依赖它判断是否需要执行工具后进入下一轮。T-013 会把这里的每一个事件
 * 再映射到协议层的事件信封（text_delta / thinking_delta / tool_call /
 * usage / turn_end 等）。
 */
export type StreamEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'thinking_delta'; readonly delta: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'finish'; readonly reason: StreamFinishReason };

/**
 * `streamChat` 入参。
 *
 * messages 采用 AI SDK 的 ModelMessage 规范格式；会话日志 → ModelMessage
 * 的投影发生在 Context / Runtime 层（T-012），本层只负责把它交给模型。
 */
export interface StreamChatInput {
  /** 系统指令（可选） */
  readonly system?: string;
  /** 对话消息（AI SDK ModelMessage 规范格式） */
  readonly messages: ModelMessage[];
  /**
   * 工具定义（可选，0.1.0 不传）。
   * 只有传了 tools，模型发出工具调用时流里才会透出 `tool_use` 事件。
   */
  readonly tools?: ToolSet;
  /**
   * 中断信号。调用方 abort 时流立即停止，并抛出
   * `ProviderError`（kind 为 `aborted`），由 loop 转入 INTERRUPTED 状态。
   */
  readonly abortSignal?: AbortSignal;
  /** API 失败重试次数（默认 2，沿用 AI SDK 默认）。 */
  readonly maxRetries?: number;
}

/**
 * 模型供应商统一接口。
 *
 * 实例 = 「供应商 + 模型 + 能力描述」三元组：T-011 接入新供应商时，
 * 构建对应 (id, modelId, capabilities) 的实例即可；`/model` 切模型等价于
 * 换一个实例。`Runtime` 只依赖这个接口，不感知任何供应商细节。
 */
export interface ModelProvider {
  /** 供应商 ID，如 `anthropic` / `openai-compat` */
  readonly id: string;
  /** 当前选用的模型 ID，如 `deepseek-v4-flash` */
  readonly modelId: string;
  /** 该模型的能力描述 */
  readonly capabilities: ProviderCapabilities;
  /**
   * 流式对话：逐事件产出。
   * 事件序列一般以 `text_delta` / `thinking_delta` / `tool_use` 开头，
   * 以 `usage` + `finish` 收尾；出错或中断时抛出 `ProviderError`。
   */
  streamChat(input: StreamChatInput): AsyncIterable<StreamEvent>;
}
