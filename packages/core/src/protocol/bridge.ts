import type { ProviderError } from '../provider/errors';
import type {
  RunAgentTurnInput,
  RuntimeEvent,
  TurnResult,
} from '../runtime/loop';
import { runAgentTurn } from '../runtime/loop';
import { EnvelopeEmitter } from './envelope';
import type { EnvelopeEmitterOptions } from './envelope';
import type { Envelope, ErrorData, ProtocolEvent } from './events';

/**
 * Runtime 内部事件 → 协议事件 的纯映射（bridge）。
 *
 * 0.1.0 映射表：
 * | RuntimeEvent     | 协议事件                            |
 * |------------------|-------------------------------------|
 * | turn_start       | turn_start（轮次开始）              |
 * | text_delta       | text_delta                          |
 * | thinking_delta   | thinking_delta                      |
 * | tool_use         | tool_call                           |
 * | usage            | usage                               |
 * | error            | error（ProviderError → ErrorData）  |
 * | turn_end         | turn_end（带终止原因）              |
 * | tool_feedback    | notice（warn）：模型调用了未知工具   |
 *
 * TODO（0.1.0 不产生，不映射）：
 * - `tool_result` / `tool_progress`：等工具管线（T-051）落地；
 * - `approval_request` / `approval_resolved`：等审批（0.3.0）落地；
 * - `context_state` / `compaction`：等上下文核算与压缩（0.6.0）落地。
 */
export function mapRuntimeEvent(event: RuntimeEvent): ProtocolEvent[] {
  switch (event.type) {
    case 'turn_start':
      return [{ type: 'turn_start', data: { turn: event.turn } }];
    case 'turn_end':
      return [
        {
          type: 'turn_end',
          data: { turn: event.turn, termination: event.termination },
        },
      ];
    case 'text_delta':
      return [{ type: 'text_delta', data: { delta: event.delta } }];
    case 'thinking_delta':
      return [{ type: 'thinking_delta', data: { delta: event.delta } }];
    case 'tool_use':
      return [
        {
          type: 'tool_call',
          data: { id: event.id, name: event.name, input: event.input },
        },
      ];
    case 'usage':
      return [{ type: 'usage', data: { ...event.usage } }];
    case 'error':
      return [{ type: 'error', data: toErrorData(event.error) }];
    case 'tool_feedback':
      // 「未知工具」错误已回喂模型；同时以 notice 告知前端发生了什么
      return [
        {
          type: 'notice',
          data: {
            level: 'warn',
            text: `模型调用了未知工具 "${event.name}"，错误已回喂，请其直接作答`,
          },
        },
      ];
    default: {
      const exhaustive: never = event;
      throw new Error(`未映射的 RuntimeEvent：${JSON.stringify(exhaustive)}`);
    }
  }
}

/** ProviderError → 协议 ErrorData（002 5.3：错误即数据，五类归一）。 */
function toErrorData(error: ProviderError): ErrorData {
  return {
    category: 'provider',
    kind: error.kind,
    recoverable: error.retryable,
    message: error.message,
  };
}

/**
 * 流式桥接（headless / TUI 用）：`runAgentTurn` + `EnvelopeEmitter`，
 * 协议事件逐条经 `onEnvelope` 回调送出 —— 前端拿到的是纯协议信封，
 * 与 core 内部对象零接触。
 */
export async function runAgentTurnStreaming(
  input: RunAgentTurnInput,
  onEnvelope: (envelope: Envelope) => void,
  options: EnvelopeEmitterOptions = {},
): Promise<TurnResult> {
  const emitter = new EnvelopeEmitter(options);
  return runAgentTurn(input, (runtimeEvent) => {
    for (const protocolEvent of mapRuntimeEvent(runtimeEvent)) {
      onEnvelope(emitter.emit(protocolEvent));
    }
  });
}

/** 收集式桥接的产出：全部信封 + TurnResult。 */
export interface ProtocolTurnResult {
  readonly envelopes: readonly Envelope[];
  readonly result: TurnResult;
}

/**
 * 收集式桥接（测试 / 程序化消费用）：跑完一次 turn，返回全部信封与结果。
 * headless 走 `runAgentTurnStreaming` 以获得真正的流式输出；这里只是
 * 把同一套桥接的产物收集成数组。
 */
export async function runTurnWithProtocol(
  input: RunAgentTurnInput,
  options: EnvelopeEmitterOptions = {},
): Promise<ProtocolTurnResult> {
  const envelopes: Envelope[] = [];
  const result = await runAgentTurnStreaming(
    input,
    (envelope) => {
      envelopes.push(envelope);
    },
    options,
  );
  return { envelopes, result };
}
