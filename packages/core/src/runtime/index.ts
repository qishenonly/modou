export type {
  RuntimeEvent,
  RunAgentTurnInput,
  TurnOptions,
  TurnResult,
  TurnTermination,
} from './loop';
export { runAgentTurn } from './loop';

// RunAgentTurnInput.messages 使用 AI SDK 的 ModelMessage 规范格式；此处再导出
// 供调用方（TUI / headless）在续写时构造消息数组，避免依赖 core 之外的类型。
export type { ModelMessage } from 'ai';

export type {
  LoopState,
  LoopTransitionName,
  StopReasonTransition,
} from './state';
export { canTransition, nextState, stopReasonToTransition } from './state';

export type { InterruptHandle } from './interrupt';
export {
  createInterruptHandle,
  extractInterruptReason,
  isInterruptError,
} from './interrupt';

export type { RetryOptions } from './retry';
export { computeBackoffDelay, withRetry } from './retry';
