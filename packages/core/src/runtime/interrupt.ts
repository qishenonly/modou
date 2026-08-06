import { isProviderError, ProviderError } from '../provider/errors';

/**
 * 中断句柄：对 AbortController 的最小封装。
 *
 * 调用方（TUI/CLI/测试）创建句柄，把 `signal` 交给 loop 透传给 provider；
 * 需要打断时调用 `abort(reason?)`。loop 捕获 aborted 错误后通过
 * `extractInterruptReason` 拿到原因，随 interrupted 结果返回给上层展示。
 */
export interface InterruptHandle {
  readonly signal: AbortSignal;
  readonly aborted: boolean;
  /** 触发 abort 时传入的原因（未中断为 undefined） */
  readonly reason: unknown;
  abort(reason?: unknown): void;
}

/** 创建中断句柄。 */
export function createInterruptHandle(): InterruptHandle {
  const controller = new AbortController();
  let reason: unknown;
  return {
    get signal(): AbortSignal {
      return controller.signal;
    },
    get aborted(): boolean {
      return controller.signal.aborted;
    },
    get reason(): unknown {
      return reason;
    },
    abort(r?: unknown): void {
      reason = r;
      controller.abort(r);
    },
  };
}

/** 类型守卫：错误是否为「中断」类（aborted）错误。 */
export function isInterruptError(error: unknown): error is ProviderError {
  return isProviderError(error) && error.kind === 'aborted';
}

/**
 * 提取中断原因（中断后的状态清理）：优先取 signal 上携带的 reason；
 * 无 signal 或未中断时，回退到 aborted 错误的 cause 链。
 */
export function extractInterruptReason(
  signal: AbortSignal | undefined,
  error: unknown,
): unknown {
  if (signal?.aborted) return signal.reason;
  if (isProviderError(error) && error.cause !== undefined) return error.cause;
  return undefined;
}
