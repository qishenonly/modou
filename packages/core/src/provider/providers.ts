import { LoadAPIKeyError } from 'ai';
import { createAnthropicProvider } from './anthropic';
import type { ProviderCapabilities } from './capabilities';
import { createOpenAICompatProvider } from './openai-compat';
import type { ModelProvider } from './types';

/** 当前支持的供应商类型。 */
export type ProviderType = 'anthropic' | 'openai-compat';

export interface ProviderConfig {
  /** 供应商类型。 */
  readonly type: ProviderType;
  /** 模型 ID。 */
  readonly modelId: string;
  /** 端点前缀（openai-compat 必须；anthropic 走代理时用）。 */
  readonly baseURL?: string;
  /** API Key；缺省时各工厂回落到对应环境变量。 */
  readonly apiKey?: string;
  /** 能力描述覆盖（可选）。 */
  readonly capabilities?: ProviderCapabilities;
}

/**
 * 统一装配入口：按 type 分发到各供应商工厂。
 *
 * 新增供应商 = 加一个 type 分支 + 一个工厂文件，其余模块零改动。
 * default 分支做 TS 穷尽检查：新 type 未处理会在这里编译报错。
 */
export function createProvider(config: ProviderConfig): ModelProvider {
  switch (config.type) {
    case 'anthropic':
      return createAnthropicProvider(config);
    case 'openai-compat':
      return createOpenAICompatProvider(config);
    default: {
      const exhaustive: never = config.type;
      throw new Error(`未知供应商类型：${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 环境变量辅助（配置驱动 baseURL 与 API Key 的落点）
// ---------------------------------------------------------------------------

/** opencode 测试端点（G-0.1.0 验收用真实端点）所需的全部环境变量。 */
export interface OpencodeEnvConfig {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly deepseekModel: string;
  readonly gptModel: string;
}

/**
 * 读取 opencode 测试端点环境变量。
 *
 * 任一缺失返回 null —— live 测试据此 skip，CI 无密钥时静默不跑外网。
 * baseURL 需携带完整 OpenAI 兼容前缀（实测 opencode 网关为
 * `https://opencode.ai/zen/go/v1`），配置即最终值，代码不做魔法修正。
 */
export function readOpencodeEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpencodeEnvConfig | null {
  const apiKey = env.MODOU_OPENCODE_API_KEY;
  const baseURL = env.MODOU_OPENCODE_BASE_URL;
  const deepseekModel = env.MODOU_TEST_MODEL_DEEPSEEK;
  const gptModel = env.MODOU_TEST_MODEL_GPT;
  if (!apiKey || !baseURL || !deepseekModel || !gptModel) return null;
  return { apiKey, baseURL, deepseekModel, gptModel };
}

/**
 * 必填 API Key 读取：缺失即抛可判定的错误。
 *
 * 抛出 LoadAPIKeyError —— T-010 已把它归一为 ProviderError(kind:
 * 'invalid_api_key')，调用方（Runtime / CLI）无需感知具体形态。
 */
export function requireApiKey(
  envVarName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[envVarName];
  if (value === undefined || value.trim() === '') {
    throw new LoadAPIKeyError({
      message: `缺少 API Key 配置（环境变量 ${envVarName}）`,
    });
  }
  return value;
}

/**
 * 从环境变量直接装配一个可用的 Provider（CLI 装配的入口）。
 *
 * 等价 `createProviderFromConfig({ type }, env)`：类型之外的字段（model /
 * baseURL）全部回落环境变量，保持既有行为不变。
 */
export function createProviderFromEnv(
  type: ProviderType,
  env: NodeJS.ProcessEnv = process.env,
): ModelProvider {
  return createProviderFromConfig({ type }, env);
}

/**
 * 配置驱动的 Provider 装配（T-080 配置系统接入）：
 * 按「供应商类型 + 可选 model / baseURL」装配，API Key 与缺失项回落环境变量。
 *
 * - openai-compat：model 未配置时优先用 opencode 测试端点（MODOU_OPENCODE_*，
 *   G-0.1.0 验收语义），否则回落 MODOU_OPENCODE_MODEL / OPENAI_MODEL / 'gpt-4o'，
 *   baseURL 回落 OPENAI_BASE_URL，apiKey 取 OPENAI_API_KEY；
 * - anthropic：model 回落 ANTHROPIC_MODEL / 'claude-sonnet-4-5'，
 *   baseURL（走代理时）由配置显式给出，apiKey 取 ANTHROPIC_API_KEY。
 *
 * 缺失 API Key 时抛 LoadAPIKeyError（可归一为 invalid_api_key）。
 */
export function createProviderFromConfig(
  config: ProviderFromConfigInput,
  env: NodeJS.ProcessEnv = process.env,
): ModelProvider {
  if (config.type === 'openai-compat') {
    const opencode = readOpencodeEnv(env);
    if (opencode !== null) {
      // opencode 测试端点已配置：无论是否显式指定 model，都走该端点 + key
      // （/model 切换时 model 显式，仅覆盖模型 ID，端点与密钥不变）
      return createProvider({
        type: 'openai-compat',
        modelId: config.model ?? opencode.deepseekModel,
        baseURL: opencode.baseURL,
        apiKey: opencode.apiKey,
      });
    }
    return createProvider({
      type: 'openai-compat',
      modelId:
        config.model ??
        env.MODOU_OPENCODE_MODEL ??
        env.OPENAI_MODEL ??
        'gpt-4o',
      baseURL: config.baseURL ?? env.OPENAI_BASE_URL,
      apiKey: requireApiKey('OPENAI_API_KEY', env),
    });
  }
  return createProvider({
    type: 'anthropic',
    modelId: config.model ?? env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    apiKey: requireApiKey('ANTHROPIC_API_KEY', env),
  });
}

/** createProviderFromConfig 的入参：配置解析产出的供应商面（type + 可选 model/baseURL）。 */
export interface ProviderFromConfigInput {
  /** 供应商类型（ResolvedConfig.provider 直接传入）。 */
  readonly type: ProviderType;
  /** 模型 ID（缺省回落环境变量）。 */
  readonly model?: string;
  /** 端点前缀（缺省回落环境变量）。 */
  readonly baseURL?: string;
}
