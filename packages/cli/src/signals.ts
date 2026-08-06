import { EventEmitter } from 'node:events';

/**
 * 信号中断句柄（T-014：SIGINT / SIGTERM 干净中断）。
 *
 * 职责：
 * - 注册信号处理器，信号到达即 `abort()` 一个 AbortController（带 reason，
 *   如 'SIGINT'），沿 runHeadless → runAgentTurn → provider 的链路传播，
 *   中断后保留已产文本（design 002 4.4：一条 AbortSignal 贯穿全链路）；
 * - 记录先到的信号名，供调用方映射退出码（128 + 信号编号）；
 * - `dispose()` 移除处理器，保证测试 / 多次调用间不残留监听器。
 *
 * 信号源可注入（默认 process）：函数级测试用一个普通 EventEmitter 即可
 * 模拟信号，不必真的向进程发信号。
 */

export type SignalName = 'SIGINT' | 'SIGTERM';

export interface SignalInterruptOptions {
  /** 信号源（测试注入 EventEmitter；默认 process） */
  readonly emitter?: EventEmitter;
}

export interface SignalInterrupt {
  /** 沿链路传播的中断信号（abort 时携带信号名作为 reason） */
  readonly signal: AbortSignal;
  /** 先触发的信号名（未触发为 undefined） */
  readonly triggered: SignalName | undefined;
  /** 移除全部信号监听器 */
  dispose(): void;
}

/**
 * 注册一组信号的中断处理器：首个信号触发一次 abort，后续信号忽略
 * （进程退出前再按同一个信号做一次「强制退出」的兜底由调用方决定，
 * 0.1.0 不实现二次强制退出）。
 */
export function createSignalInterrupt(
  signalNames: readonly SignalName[] = ['SIGINT', 'SIGTERM'],
  options: SignalInterruptOptions = {},
): SignalInterrupt {
  const emitter = options.emitter ?? process;
  const controller = new AbortController();
  let triggered: SignalName | undefined;

  const listeners = new Map<SignalName, () => void>();
  for (const name of signalNames) {
    const handler = (): void => {
      if (triggered !== undefined) return; // 已中断过一次
      triggered = name;
      controller.abort(name);
    };
    emitter.on(name, handler);
    listeners.set(name, handler);
  }

  return {
    get signal(): AbortSignal {
      return controller.signal;
    },
    get triggered(): SignalName | undefined {
      return triggered;
    },
    dispose(): void {
      for (const [name, handler] of listeners) {
        emitter.off(name, handler);
      }
      listeners.clear();
    },
  };
}

/**
 * 中断退出码：POSIX 惯例「128 + 信号编号」。
 * SIGINT（编号 2）→ 130；SIGTERM（编号 15）→ 143。
 * 两者取不同的惯例值，便于从退出码区分中断来源。
 */
export function signalToExitCode(name: SignalName): number {
  return name === 'SIGINT' ? 130 : 143;
}
