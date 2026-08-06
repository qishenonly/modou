import {
  isProviderError,
  normalizeProviderError,
  ProviderError,
} from '../provider/errors';
import type { StreamEvent } from '../provider/types';
import { isInterruptError } from './interrupt';

/**
 * 指数退避重试（T-014，design 002 5.3「供应商错误 → 退避重试」）。
 *
 * 与 AI SDK 内部 maxRetries 的关系：`streamText` 默认在 SDK 层已按
 * maxRetries（当前 2）先行重试过供应商 429 / 5xx，到达本层的错误已是
 * SDK 重试后的最终形态；本层再按自己的次数上限补一轮退避重试。两层
 * 各自有硬上限，总请求次数 ≤ SDK 层上限 × 本层上限，受控不失控。
 *
 * 重试语义（本层最关键的约束）：
 * - 只有「本尝试尚未产出任何事件」的失败才整体重试 —— 流一旦吐过
 *   text_delta / tool_use / usage 等事件就说明请求已产生部分结果，
 *   此时重试会造成内容重复、事件断裂，直接按错误终止（已产出的
 *   部分内容由调用方保留，这正是「中断/出错后保留已产文本」的要求）；
 * - 中断（aborted）与不可重试错误（invalid_api_key / auth / not_found /
 *   bad_request / unknown）不重试，原样上抛；
 * - 达到最大尝试次数后，把最后一次错误包装成带「已重试 N 次仍失败」
 *   说明的 ProviderError 上抛 —— 语义是「耗尽后升级为面向用户的 error」
 *   （002 5.3），kind / statusCode / retryable 原样保留，便于上层分类。
 */

/** 重试参数（全部可注入，便于测试用假时钟 / 0 延迟 / 确定性抖动）。 */
export interface RetryOptions {
  /** 最多尝试次数（含首次请求），默认 3 */
  readonly maxAttempts?: number;
  /** 退避基数 ms（第 n 次失败后等待 base × 2^(n-1)），默认 500 */
  readonly baseDelayMs?: number;
  /** 退避延迟上限 ms，默认 8000 */
  readonly maxDelayMs?: number;
  /** 抖动系数：延迟 × (1 + random() × jitterFactor)，默认 0.5；0 关闭抖动 */
  readonly jitterFactor?: number;
  /** 延时函数（测试注入假时钟；生产用 setTimeout） */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 随机数源（测试注入固定值得到确定性退避） */
  readonly random?: () => number;
  /**
   * 中断信号。退避等待期间 signal 触发则立即中止（抛 aborted），
   * 保证 SIGINT 抵达时不需要干等一个退避周期 —— 「干净中断」的一部分。
   */
  readonly abortSignal?: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8000;
const DEFAULT_JITTER_FACTOR = 0.5;

/** 默认延时：setTimeout。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toProviderError(error: unknown): ProviderError {
  return isProviderError(error) ? error : normalizeProviderError(error);
}

/**
 * 计算第 `attemptNumber` 次失败后的等待时长：
 * `min(base × 2^(attempt-1), maxDelay) × (1 + random() × jitterFactor)`。
 * 独立导出便于单元测试直接断言退避曲线。
 */
export function computeBackoffDelay(
  attemptNumber: number,
  options: RetryOptions = {},
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const cap = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitter = options.jitterFactor ?? DEFAULT_JITTER_FACTOR;
  const random = options.random ?? Math.random;
  const exponential = base * 2 ** (attemptNumber - 1);
  const capped = Math.min(exponential, cap);
  const jittered = jitter > 0 ? capped * (1 + random() * jitter) : capped;
  return Math.round(jittered);
}

/**
 * 可中断的退避等待：signal 触发时抛 ProviderError(aborted)，让退避期间
 * 的 SIGINT 也能立刻停下来。
 *
 * 有 signal 时自持 setTimeout 以便 abort 时 clearTimeout —— 保证「干净
 * 中断」不留悬挂定时器（注入的 sleep 在此场景被旁路；无 signal 时才走
 * 注入 sleep，供测试用假时钟 / 0 延迟）。
 */
async function sleepOrAbort(
  ms: number,
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal === undefined) {
    await sleep(ms);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError({ kind: 'aborted', message: '请求已被中断' }));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new ProviderError({ kind: 'aborted', message: '请求已被中断' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 重试耗尽：包装最后一次错误，标注已重试次数（kind 等原样保留）。 */
function wrapExhausted(
  error: ProviderError,
  attemptNumber: number,
): ProviderError {
  const retried = attemptNumber - 1;
  if (retried <= 0) return error;
  return new ProviderError({
    kind: error.kind,
    statusCode: error.statusCode,
    retryable: error.retryable,
    category: error.category,
    cause: error,
    message: `重试 ${retried} 次仍失败（${error.kind}）：${error.message}`,
  });
}

/**
 * 包装一次模型请求：`attempt(n)` 返回第 n 次尝试的流。
 *
 * 消费方式与 provider 流一致：`for await` 逐事件透出；失败时按重试
 * 语义决定「重试 / 上抛」。消费方中断（break / abort）会关闭内层流，
 * 不会误触发重试（return 完成不会进入 catch 分支）。
 */
export async function* withRetry(
  attempt: (attemptNumber: number) => AsyncIterable<StreamEvent>,
  options: RetryOptions = {},
): AsyncGenerator<StreamEvent> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.abortSignal;

  for (
    let attemptNumber = 1;
    attemptNumber <= maxAttempts;
    attemptNumber += 1
  ) {
    let produced = false;
    try {
      for await (const event of attempt(attemptNumber)) {
        produced = true;
        yield event;
      }
      return; // 本次尝试正常收尾（含 finish），整体成功
    } catch (caught) {
      const error = toProviderError(caught);

      // 中断：信号已传达，重试毫无意义，原样上抛
      if (isInterruptError(error)) throw error;
      // 不可重试错误（鉴权 / 请求参数 / 未知）：不重试
      if (!error.retryable) throw error;
      // 本尝试已产出事件：重试会重复内容，直接按错误终止
      if (produced) throw error;
      // 已达最大尝试次数：升级为面向用户的 error 后上抛
      if (attemptNumber >= maxAttempts) {
        throw wrapExhausted(error, attemptNumber);
      }

      await sleepOrAbort(
        computeBackoffDelay(attemptNumber, options),
        signal,
        sleep,
      );
    }
  }

  // 理论不可达：for 循环每次迭代要么 return 要么 throw
  return;
}
