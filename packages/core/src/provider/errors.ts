import { APICallError, LoadAPIKeyError, RetryError } from 'ai';

/**
 * 归一后的错误分类。
 *
 * 供应商错误（429 / 5xx / 超时 / 无效密钥 / 中断…）全部归一到这个枚举，
 * `Runtime` 只需按 kind 判定：`rate_limited` / `server_error` / `timeout`
 * 标记为可重试（T-014 指数退避依据），其余不可重试。
 */
export type ProviderErrorKind =
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'invalid_api_key'
  | 'auth'
  | 'not_found'
  | 'bad_request'
  | 'aborted'
  | 'unknown';

const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limited',
  'server_error',
  'timeout',
]);

/**
 * 错误归属类别（design 002 5.3 五类错误中的后两类）：
 * - `provider`：可判定的供应商错误（429 / 5xx / 超时 / 鉴权…），
 *   按 kind 分类处置；
 * - `internal`：无法归一的内部错误（适配器 bug、非供应商未知异常），
 *   不回喂模型，直接报用户并记日志。
 */
export type ProviderErrorCategory = 'provider' | 'internal';

/**
 * 统一的供应商错误。`kind` 可判定、`retryable` 可决策、`category` 区分
 * 供应商错误与内部错误、`cause` 保留原始错误。
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** HTTP 状态码（有则填） */
  readonly statusCode?: number;
  /** 是否可重试（T-014 据此做指数退避） */
  readonly retryable: boolean;
  /** 归属类别：供应商错误 / 内部错误（默认 provider） */
  readonly category: ProviderErrorCategory;
  readonly cause?: unknown;

  constructor(options: {
    kind: ProviderErrorKind;
    message: string;
    statusCode?: number;
    retryable?: boolean;
    category?: ProviderErrorCategory;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = 'ProviderError';
    this.kind = options.kind;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? RETRYABLE_KINDS.has(options.kind);
    this.category = options.category ?? 'provider';
    this.cause = options.cause;
  }
}

/** 类型守卫：判断一个未知值是否为 ProviderError。 */
export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

function errorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name;
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}

/**
 * 把任意供应商错误归一到 ProviderError。
 *
 * 覆盖 AI SDK 抛出的 APICallError / RetryError / LoadAPIKeyError、
 * DOMException 形态的 abort / timeout，以及无法判定的未知错误。
 */
export function normalizeProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;

  const name = errorName(error);
  if (name === 'TimeoutError') {
    return new ProviderError({
      kind: 'timeout',
      message: '请求超时',
      cause: error,
    });
  }
  if (name === 'AbortError' || name === 'ResponseAborted') {
    return new ProviderError({
      kind: 'aborted',
      message: '请求已被中断',
      cause: error,
    });
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    switch (status) {
      case 400:
        return new ProviderError({
          kind: 'bad_request',
          message: '请求参数被供应商拒绝（400）',
          statusCode: status,
          cause: error,
        });
      case 401:
        return new ProviderError({
          kind: 'invalid_api_key',
          message: 'API Key 无效或缺失（401）',
          statusCode: status,
          cause: error,
        });
      case 403:
        return new ProviderError({
          kind: 'auth',
          message: '无权限访问该模型（403）',
          statusCode: status,
          cause: error,
        });
      case 404:
        return new ProviderError({
          kind: 'not_found',
          message: '模型或端点不存在（404）',
          statusCode: status,
          cause: error,
        });
      case 429:
        return new ProviderError({
          kind: 'rate_limited',
          message: '触发供应商限流（429）',
          statusCode: status,
          cause: error,
        });
      default:
        if (status !== undefined && status >= 500) {
          return new ProviderError({
            kind: 'server_error',
            message: `供应商服务端错误（${status}）`,
            statusCode: status,
            cause: error,
          });
        }
        return new ProviderError({
          kind: 'unknown',
          message: `未知的 API 错误（${status ?? '无状态码'}）`,
          statusCode: status,
          cause: error,
        });
    }
  }

  if (RetryError.isInstance(error)) {
    if (error.reason === 'abort') {
      return new ProviderError({
        kind: 'aborted',
        message: '请求已被中断',
        cause: error,
      });
    }
    // RetryError 是对最后一次失败的包装，递归归一原始错误
    return normalizeProviderError(error.lastError);
  }

  if (LoadAPIKeyError.isInstance(error)) {
    return new ProviderError({
      kind: 'invalid_api_key',
      message: '缺少 API Key 配置',
      cause: error,
    });
  }

  const message = errorMessage(error) ?? '未知错误';
  if (/timeout/i.test(message)) {
    return new ProviderError({
      kind: 'timeout',
      message: '请求超时',
      cause: error,
    });
  }

  // 走到这里说明既不是 API 错误也不是 SDK 分类错误：视为内部错误
  // （适配器 bug / 未知异常），category 置 internal —— 不回喂模型，
  // 直接报用户（design 002 5.3）。
  return new ProviderError({
    kind: 'unknown',
    message,
    cause: error,
    category: 'internal',
  });
}
