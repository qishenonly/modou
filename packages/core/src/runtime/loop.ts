import type { ModelMessage, TextPart, ToolCallPart } from 'ai';
import {
  isProviderError,
  normalizeProviderError,
  ProviderError,
} from '../provider/errors';
import type {
  ModelProvider,
  StreamFinishReason,
  TokenUsage,
} from '../provider/types';
import { extractInterruptReason, isInterruptError } from './interrupt';
import {
  canTransition,
  stopReasonToTransition,
  type LoopState,
  type LoopTransitionName,
} from './state';

export interface TurnOptions {
  /** 轮次上限：允许发起的最大模型请求数，超限即终止并标记 halted */
  readonly maxTurns: number;
  /**
   * 预算上限（token）：累计 input + output 超过即终止（0.1.0 简化预算，
   * 只在每轮 usage 到达后检查；T-052 会替换为完整预算核算）。
   */
  readonly maxTokens?: number;
  /** 中断信号：透传给 provider；触发后本轮终止为 interrupted */
  readonly abortSignal?: AbortSignal;
}

export interface RunAgentTurnInput {
  readonly provider: ModelProvider;
  readonly system?: string;
  /** 对话消息（AI SDK ModelMessage 规范格式）。loop 只追加自己的副本，不改入参。 */
  readonly messages: ModelMessage[];
  readonly options: TurnOptions;
}

export type TurnTermination = 'end_turn' | 'halted' | 'interrupted' | 'error';

/** 一次 `runAgentTurn` 的产出：汇总文本、累计用量、终止原因。 */
export interface TurnResult {
  /** 全部轮次产出的文本（含终止/打断前已产出的部分） */
  readonly text: string;
  /** 累计 token 用量（各分项缺失时保持 undefined） */
  readonly usage: TokenUsage;
  /** 最后一轮的 finish reason（未收到 finish 事件时为 null） */
  readonly finishReason: StreamFinishReason | null;
  readonly termination: TurnTermination;
  /** 实际完成的轮次（模型请求数） */
  readonly turns: number;
  /** 终止时的状态机状态 */
  readonly state: LoopState;
  /** termination === 'error' 时的归一错误 */
  readonly error?: ProviderError;
  /** termination === 'interrupted' 时的中断原因（来自 abort signal） */
  readonly interruptedReason?: unknown;
}

/**
 * Runtime 内部事件流。T-013 会把这里的每个事件映射为协议层信封
 * （turn_start / turn_end / text_delta / thinking_delta / tool_call / usage /
 * error）。`tool_feedback` 是 runtime 层事件：标识「未知工具」错误已回喂模型。
 */
export type RuntimeEvent =
  | { readonly type: 'turn_start'; readonly turn: number }
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'thinking_delta'; readonly delta: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_feedback';
      readonly id: string;
      readonly name: string;
      readonly error: string;
    }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'error'; readonly error: ProviderError }
  | {
      readonly type: 'turn_end';
      readonly turn: number;
      readonly termination: TurnTermination;
    };

/** 0.1.0 无工具注册表：任何 tool_use 都走「未知工具」错误回喂。 */
const UNKNOWN_TOOL_MESSAGE = (name: string): string =>
  `未知工具 "${name}"：0.1.0 尚未接入工具注册表。请勿调用任何工具，直接用文本回答用户。`;

/** 归一任意错误为 ProviderError（provider 适配层本应已归一，此处兜底）。 */
function toProviderError(error: unknown): ProviderError {
  return isProviderError(error) ? error : normalizeProviderError(error);
}

/**
 * Agent loop 内核（002 4.2 / 4.3）：`while(tool_use)` 裸循环。
 *
 * 主流程：
 * 1. idle → assemble → streaming，发起一次 `provider.streamChat`；
 * 2. 流中事件直接透出（text / thinking / tool_use / usage），
 *    文本累计进结果、usage 累计进账本；
 * 3. `stop_reason` 驱动流转（stopReasonToTransition）：
 *    - `tool_use` → executing：0.1.0 无工具注册表，把「未知工具」错误
 *      以 assistant tool-call + tool 错误结果回喂，继续下一轮；
 *    - 其余 → end_turn 收尾回 idle；
 *    - `error` → 终止为 error。
 * 4. 上限兜底：轮次在 ASSEMBLE 检查、预算在每轮 usage 后检查，超限 → halted；
 *    中断经 abort signal 透传 provider，捕获 aborted 错误后转 interrupted，
 *    已产出的文本照常返回。
 *
 * Runtime 保持薄：只做编排，不做业务判断（判断在模型那边）。
 */
export async function runAgentTurn(
  input: RunAgentTurnInput,
  onEvent?: (event: RuntimeEvent) => void,
): Promise<TurnResult> {
  const { provider, system, messages, options } = input;
  const { maxTurns, maxTokens, abortSignal } = options;
  const emit = onEvent ?? (() => {});

  let state: LoopState = 'idle';
  let termination: TurnTermination = 'end_turn';
  let turn = 0;
  let text = '';
  let usage: TokenUsage = {};
  let finishReason: StreamFinishReason | null = null;
  let error: ProviderError | undefined;
  let interruptedReason: unknown;

  /** 追加写的消息线程。绝不修改调用方的 messages。 */
  const thread: ModelMessage[] = [...messages];

  /** 状态机迁移守卫：非法迁移是不变量破坏，正常路径不会触发。 */
  const move = (transition: LoopTransitionName): LoopState => {
    const next = canTransition(state, transition);
    if (next === null) {
      throw new Error(`非法状态迁移：${state} --${transition}--> ?`);
    }
    state = next;
    return next;
  };

  const accumulateUsage = (partial: TokenUsage): void => {
    const plus = (
      a: number | undefined,
      b: number | undefined,
    ): number | undefined =>
      a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    usage = {
      inputTokens: plus(usage.inputTokens, partial.inputTokens),
      outputTokens: plus(usage.outputTokens, partial.outputTokens),
      noCacheTokens: plus(usage.noCacheTokens, partial.noCacheTokens),
      cacheReadTokens: plus(usage.cacheReadTokens, partial.cacheReadTokens),
      cacheWriteTokens: plus(usage.cacheWriteTokens, partial.cacheWriteTokens),
    };
  };

  const budgetExceeded = (): boolean => {
    if (maxTokens === undefined) return false;
    return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) > maxTokens;
  };

  /** 把本轮产出（文本 + tool_use）与「未知工具」错误回喂给模型。 */
  const feedBackUnknownTool = (
    roundText: string,
    toolUses: Array<{ id: string; name: string; input: unknown }>,
  ): void => {
    const assistantContent: Array<TextPart | ToolCallPart> = [];
    if (roundText.length > 0) {
      assistantContent.push({ type: 'text', text: roundText });
    }
    for (const call of toolUses) {
      assistantContent.push({
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
      });
    }
    thread.push({ role: 'assistant', content: assistantContent });
    thread.push({
      role: 'tool',
      content: toolUses.map((call) => ({
        type: 'tool-result',
        toolCallId: call.id,
        toolName: call.name,
        output: { type: 'error-text', value: UNKNOWN_TOOL_MESSAGE(call.name) },
      })),
    });
  };

  const finalize = (): TurnResult => {
    const result: TurnResult = {
      text,
      usage,
      finishReason,
      termination,
      turns: turn,
      state,
      ...(error !== undefined ? { error } : {}),
      ...(termination === 'interrupted' && interruptedReason !== undefined
        ? { interruptedReason }
        : {}),
    };
    emit({ type: 'turn_end', turn, termination });
    return result;
  };

  // —— 状态机入口：idle --submit--> assemble ——
  move('submit');

  for (;;) {
    // —— ASSEMBLE：轮次上限检查（预算检查在每轮 usage 后即时做，见下）——
    if (turn >= maxTurns) {
      move('limits_exceeded'); // assemble → halted
      termination = 'halted';
      break;
    }

    turn += 1;
    emit({ type: 'turn_start', turn });

    // assemble --request_started--> streaming
    move('request_started');

    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
    let roundText = '';
    let roundError: ProviderError | undefined;
    let aborted = false;

    try {
      for await (const event of provider.streamChat({
        system,
        messages: thread,
        abortSignal,
      })) {
        switch (event.type) {
          case 'text_delta':
            roundText += event.delta;
            text += event.delta;
            emit({ type: 'text_delta', delta: event.delta });
            break;
          case 'thinking_delta':
            emit({ type: 'thinking_delta', delta: event.delta });
            break;
          case 'tool_use':
            toolUses.push({
              id: event.id,
              name: event.name,
              input: event.input,
            });
            emit({
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: event.input,
            });
            break;
          case 'usage':
            accumulateUsage(event.usage);
            emit({ type: 'usage', usage: event.usage });
            break;
          case 'finish':
            finishReason = event.reason;
            break;
        }
      }
    } catch (caught) {
      const providerError = toProviderError(caught);
      if (isInterruptError(providerError)) {
        aborted = true;
        interruptedReason = extractInterruptReason(abortSignal, providerError);
      } else {
        roundError = providerError;
      }
    }

    // —— 中断：streaming --interrupt--> interrupted ——
    if (aborted) {
      move('interrupt');
      termination = 'interrupted';
      break;
    }

    // —— 供应商错误：streaming --error--> halted ——
    if (roundError !== undefined) {
      error = roundError;
      move('error');
      termination = 'error';
      emit({ type: 'error', error });
      break;
    }

    // —— 预算上限（0.1.0 简化）：本轮 usage 已累计，超限即终止 ——
    if (budgetExceeded()) {
      move('limits_exceeded'); // streaming → halted
      termination = 'halted';
      break;
    }

    // —— stop_reason 直接驱动流转 ——
    if (finishReason !== null) {
      const mapped = stopReasonToTransition(finishReason);

      if (mapped.transition === 'tool_use') {
        if (toolUses.length === 0) {
          // 防御：理论上不会出现「reason=tool_use 却无 tool_use 事件」；
          // 按 end_turn 收尾，避免死循环。
          move('end_turn'); // streaming → idle
          break;
        }
        // streaming --tool_use--> executing：0.1.0 无工具注册表，走未知工具回喂
        move('tool_use');
        for (const call of toolUses) {
          emit({
            type: 'tool_feedback',
            id: call.id,
            name: call.name,
            error: UNKNOWN_TOOL_MESSAGE(call.name),
          });
        }
        feedBackUnknownTool(roundText, toolUses);
        move('tool_result_logged'); // executing → assemble
        continue;
      }

      if (mapped.transition === 'error') {
        error = new ProviderError({
          kind: 'unknown',
          message: '模型流以 error 收尾（content-filter 或供应商内部错误）',
        });
        move('error'); // streaming → halted
        termination = 'error';
        emit({ type: 'error', error });
        break;
      }
    }

    // end_turn（stop / length / content-filter / other，或未收到 finish）
    move('end_turn'); // streaming → idle
    break;
  }

  return finalize();
}
