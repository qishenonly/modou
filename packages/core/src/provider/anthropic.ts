import { createAnthropic } from '@ai-sdk/anthropic';
import type { ProviderCapabilities } from './capabilities';
import type { ModelProvider } from './types';
import { VercelModelProvider } from './vercel';
import type { CreateModel } from './vercel';

/**
 * Claude 系列默认能力描述。
 *
 * - maxContext 200000：sonnet / opus / haiku 的官方上下文窗口；
 * - parallelToolCalls / cacheBreakpoints / images：Anthropic 原生支持；
 * - thinking 'native'：推理走独立 reasoning 通道，本层透出为 thinking_delta；
 * - strictJsonArgs true：Anthropic 对工具参数 JSON 严格，无需容错解析。
 *
 * 若个别模型有出入，调用方可用 `capabilities` 覆盖。
 */
export const ANTHROPIC_DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContext: 200_000,
  parallelToolCalls: true,
  cacheBreakpoints: true,
  images: true,
  thinking: 'native',
  strictJsonArgs: true,
};

export interface AnthropicProviderConfig {
  /** 模型 ID，如 `claude-sonnet-4-5`。 */
  readonly modelId: string;
  /** API Key；缺省时由 @ai-sdk/anthropic 回落 ANTHROPIC_API_KEY 环境变量。 */
  readonly apiKey?: string;
  /** 端点前缀（走代理 / 中转时用），缺省 https://api.anthropic.com/v1。 */
  readonly baseURL?: string;
  /** 能力描述覆盖（可选）。 */
  readonly capabilities?: ProviderCapabilities;
  /**
   * 模型构造注入口（测试专用）：注入自定义 createModel 后，
   * 离线契约测试可以在不访问外网的情况下跑通整个工厂。
   */
  readonly createModel?: CreateModel;
}

/**
 * 构造 Anthropic 供应商实例。
 *
 * 适配要点：把 @ai-sdk/anthropic 的 provider（`anthropic(modelId)` 形式）
 * 包成统一 CreateModel；能力描述按 Claude 出厂值给出。模型切换 = 换一个
 * modelId 重新构造实例，`Runtime` 不感知任何供应商细节。
 */
export function createAnthropicProvider(
  options: AnthropicProviderConfig,
): ModelProvider {
  const createModel: CreateModel =
    options.createModel ??
    ((modelId) => {
      const provider = createAnthropic({
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      });
      return provider(modelId);
    });

  return new VercelModelProvider({
    id: 'anthropic',
    modelId: options.modelId,
    capabilities: options.capabilities ?? ANTHROPIC_DEFAULT_CAPABILITIES,
    createModel,
  });
}
