import type { StreamFinishReason } from '../provider/types';

/**
 * Agent loop 状态机（design 002 4.3 节）。
 *
 * 状态全集（0.1.0）：
 * - `idle`：本轮收尾后的稳定点，等待下一次 submit；
 * - `assemble`：上下文组装中。0.1.0 的 Context 层尚未落地，本状态近似为
 *   「发起请求前的准备态」，轮次上限检查在此进行；
 * - `streaming`：模型流式输出中；
 * - `executing`：工具执行中。0.1.0 无工具注册表，本状态只承载
 *   「未知工具」错误回喂路径；
 * - `interrupted`：被 AbortSignal 打断，机器停在可恢复稳定点；
 * - `halted`：上限终止（max_turns / 预算），不可再迁移。
 *
 * COMPACTING（0.6.0 引入，见 002 4.3）：EXECUTING --结果入日志后超阈值-->
 * COMPACTING --摘要状态已更新--> ASSEMBLE。本版只留接口注释，不实现：
 * 0.1.0 在 EXECUTING 后直接回 ASSEMBLE，或经 `limits_exceeded` 到 HALTED。
 */
export type LoopState =
  'idle' | 'assemble' | 'streaming' | 'executing' | 'interrupted' | 'halted';

/**
 * 迁移名。迁移表严格对齐 002 4.3 的状态图，另有两处 0.1.0 增补：
 * - `streaming --limits_exceeded--> halted`：预算在 usage 到达后即时检查，
 *   是「预算/轮次超限」在 0.1.0 简化预算下的落点（见下 EDGES 注释）；
 * - `streaming --error--> halted`：供应商错误归一后终止（002 5.3 内部错误
 *   以外的供应商错误在 T-014 做退避重试，本版直接收尾）。
 */
export type LoopTransitionName =
  | 'submit'
  | 'request_started'
  | 'tool_use'
  | 'end_turn'
  | 'interrupt'
  | 'steer'
  | 'no_follow_up'
  | 'tool_result_logged'
  | 'limits_exceeded'
  | 'error';

/** `stop_reason` → 迁移的映射结果。 */
export interface StopReasonTransition {
  readonly transition: LoopTransitionName;
  /** 该迁移的目标状态 */
  readonly to: LoopState;
}

/**
 * 合法迁移表。
 *
 * 严格对应 002 4.3 的状态图：
 * idle --submit--> assemble；assemble --request_started--> streaming；
 * streaming --tool_use--> executing / --end_turn--> idle / --interrupt--> interrupted；
 * interrupted --steer--> assemble / --no_follow_up--> idle；
 * executing --tool_result_logged--> assemble。
 *
 * 0.1.0 增补两条到 halted 的边（上文已注释）。`halted` 是终态，无出边。
 */
const EDGES: ReadonlyMap<
  LoopState,
  ReadonlyMap<LoopTransitionName, LoopState>
> = new Map([
  ['idle', new Map([['submit', 'assemble']])],
  [
    'assemble',
    new Map([
      ['request_started', 'streaming'],
      ['limits_exceeded', 'halted'],
    ]),
  ],
  [
    'streaming',
    new Map([
      ['tool_use', 'executing'],
      ['end_turn', 'idle'],
      ['interrupt', 'interrupted'],
      ['limits_exceeded', 'halted'],
      ['error', 'halted'],
    ]),
  ],
  ['executing', new Map([['tool_result_logged', 'assemble']])],
  [
    'interrupted',
    new Map([
      ['steer', 'assemble'],
      ['no_follow_up', 'idle'],
    ]),
  ],
  ['halted', new Map()],
]);

/**
 * 迁移守卫：`from` 在 `transition` 下能否合法迁移；合法返回目标状态，
 * 非法返回 `null`。loop 用它驱动每次状态流转。
 */
export function canTransition(
  from: LoopState,
  transition: LoopTransitionName,
): LoopState | null {
  return EDGES.get(from)?.get(transition) ?? null;
}

/**
 * 等价守卫的强制版本：非法迁移视为不变量破坏，直接抛错。
 * loop 的正常路径不会触发；触发即说明 runtime 漏了某种状态处理。
 */
export function nextState(
  from: LoopState,
  transition: LoopTransitionName,
): LoopState {
  const next = canTransition(from, transition);
  if (next === null) {
    throw new Error(`非法状态迁移：${from} --${transition}--> ?`);
  }
  return next;
}

/** provider 归一后的 finish reason → 迁移映射。 */
const STOP_REASON_TRANSITION: Readonly<
  Record<StreamFinishReason, StopReasonTransition>
> = {
  tool_use: { transition: 'tool_use', to: 'executing' },
  stop: { transition: 'end_turn', to: 'idle' },
  length: { transition: 'end_turn', to: 'idle' },
  'content-filter': { transition: 'end_turn', to: 'idle' },
  other: { transition: 'end_turn', to: 'idle' },
  error: { transition: 'error', to: 'halted' },
};

/**
 * `stop_reason` 直接驱动状态流转（002 4.3）：`tool_use` → 继续执行，
 * `end_turn` 一类 → 收尾回 idle，`error` → 终止。
 */
export function stopReasonToTransition(
  reason: StreamFinishReason,
): StopReasonTransition {
  return STOP_REASON_TRANSITION[reason];
}
