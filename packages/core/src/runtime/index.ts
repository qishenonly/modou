export type {
  RuntimeEvent,
  RunAgentTurnInput,
  TurnOptions,
  TurnResult,
  TurnTermination,
} from './loop';
export { runAgentTurn } from './loop';

// 0.17.0 T-170 自定义 agents：角色化派发器（复用子代理运行时）
export {
  createAgentRunner,
  deriveAgentRegistry,
  buildAgentSystemPrompt,
} from './agent';
export type { AgentRunnerOptions } from './agent';

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

// T-130 非交互模式增强（0.13.0）：程序化入口——事件流 JSON 收集 + 退出码语义化
// + stdin 管道输入。脚本 / CI 消费 `runAgentTurnJson` 的产出（events / exitCode /
// result），不需要 TTY。
export {
  runAgentTurnJson,
  exitCodeFor,
  RunExitCode,
  readStdinPrompt,
} from './json';
export type {
  JsonSafeTurnResult,
  RunAgentTurnJsonOptions,
  RunAgentTurnJsonResult,
} from './json';
