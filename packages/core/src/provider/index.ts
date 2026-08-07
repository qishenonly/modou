export type { ProviderCapabilities } from './capabilities';

export type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
  StreamFinishReason,
  TokenUsage,
} from './types';

export {
  isProviderError,
  normalizeProviderError,
  ProviderError,
} from './errors';
export type { ProviderErrorKind } from './errors';

export { VercelModelProvider } from './vercel';
export type { CreateModel, VercelModelProviderOptions } from './vercel';
export { applyCacheBreakpoints, computeCacheHitRate } from './vercel';
export type { CacheBreakpointHints } from './vercel';

export { createAnthropicProvider } from './anthropic';
export type { AnthropicProviderConfig } from './anthropic';
export { ANTHROPIC_DEFAULT_CAPABILITIES } from './anthropic';

export {
  createOpenAICompatProvider,
  parseToolArgsLenient,
} from './openai-compat';
export type {
  LenientParseResult,
  OpenAICompatProviderConfig,
} from './openai-compat';
export {
  LenientToolArgsModel,
  OPENAI_COMPAT_DEFAULT_CAPABILITIES,
} from './openai-compat';

export {
  createProvider,
  createProviderFromEnv,
  readOpencodeEnv,
  requireApiKey,
} from './providers';
export type {
  OpencodeEnvConfig,
  ProviderConfig,
  ProviderType,
} from './providers';

export { runContractTests } from './contract/contract.test';
export type { ContractProviderBundle } from './contract/contract.test';
