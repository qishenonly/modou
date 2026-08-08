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
 * 0.3.0 映射表：
 * | RuntimeEvent       | 协议事件                            |
 * |--------------------|-------------------------------------|
 * | turn_start         | turn_start（轮次开始）              |
 * | text_delta         | text_delta                          |
 * | thinking_delta     | thinking_delta                      |
 * | tool_use           | tool_call                           |
 * | tool_result        | tool_result（工具管线执行结果）     |
 * | approval_request   | approval_request（③ Authorize 弹窗）|
 * | approval_resolved  | approval_resolved（裁决收尾）       |
 * | usage              | usage                               |
 * | context_state      | context_state（分项 + 合计 + drift）|
 * | compaction         | compaction（压缩前后 token、折叠轮次）|
 * | notice             | notice（loop 侧提示，如压缩跳过）   |
 * | error              | error（ProviderError → ErrorData）  |
 * | turn_end           | turn_end（带终止原因）              |
 * | tool_feedback      | notice（warn）：模型调用了未知工具   |
 *
 * `tool_result` 何时产生（T-051）：loop 在 tool_use 分支调用 runToolPipeline，
 * 管线 ⑧ Record 发出的 tool_result 协议事件由 loop 转成同形 RuntimeEvent，
 * 此处再映射回协议 tool_result —— 前端拿到的是「工具执行结果」协议事件；
 * 流式阶段的 tool_use 事件（→ tool_call）负责「模型正在请求调用」的即时展示。
 *
 * TODO（本版不产生，不映射）：
 * - `tool_progress`：等长命令实时输出（bash 工具落地时）。
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
    case 'context_state':
      // 上下文分项核算（T-063）：loop 每轮收尾发出，前端 /context 视图直接消费
      return [{ type: 'context_state', data: event.data }];
    case 'compaction':
      // 压缩事件（T-070）：压缩前后 token、被折叠的轮次范围——前端据此
      // 告知用户「刚压缩过」（002 3.2 compaction 表）。
      return [{ type: 'compaction', data: event.data }];
    case 'todo_update':
      // 待办清单更新（T-110 TodoWrite）：一次清单快照——前端据此渲染
      // 进度条 / 勾选（002 3.2 todo_update 表，T-111）。
      return [{ type: 'todo_update', data: { items: event.items } }];
    case 'notice':
      // loop 侧提示（T-070：压缩跳过 / 压缩失败等），与协议 notice 同形
      return [
        { type: 'notice', data: { level: event.level, text: event.text } },
      ];
    case 'tool_result':
      // 工具执行结果：与人看的 tool_result 协议事件同形，直接映射
      return [
        {
          type: 'tool_result',
          data: {
            id: event.id,
            ok: event.ok,
            summary: event.summary,
            ...(event.forModel !== undefined
              ? { forModel: event.forModel }
              : {}),
            ...(event.payload !== undefined ? { payload: event.payload } : {}),
          },
        },
      ];
    case 'approval_request':
      // 审批请求（T-033 ③ Authorize）：与协议 approval_request 同形，直接映射
      return [
        {
          type: 'approval_request',
          data: {
            id: event.id,
            description: event.description,
            risk: event.risk,
            options: event.options,
          },
        },
      ];
    case 'approval_resolved':
      // 审批裁决收尾：弹窗关闭的依据
      return [
        {
          type: 'approval_resolved',
          data: {
            id: event.id,
            decision: event.decision,
            source: event.source,
          },
        },
      ];
    case 'error':
      return [{ type: 'error', data: toErrorData(event.error) }];
    case 'subagent_event':
      // 子代理内部事件按同一规则映射（信封的 agent 由流式桥接按 agent 分发——
      // 本函数只负责事件类型层映射）。一层深硬限制保证内层不再嵌套
      // subagent_event，递归仅作防御。
      return mapRuntimeEvent(event.event);
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
    category: error.category,
    kind: error.kind,
    recoverable: error.retryable,
    message: error.message,
  };
}

/**
 * 流式桥接（headless / TUI 用）：`runAgentTurn` + `EnvelopeEmitter`，
 * 协议事件逐条经 `onEnvelope` 回调送出 —— 前端拿到的是纯协议信封，
 * 与 core 内部对象零接触。
 *
 * T-122（0.12.0 子代理事件流）：子代理的 `subagent_event` 在此按 agent 分发
 * 到独立的子 EnvelopeEmitter——每个子代理有自己的 agent 字段与独立的
 * seq / turn 空间（信封的 `agent` 字段从第一天就存在，002 3.1 的便宜先手），
 * 前端按 `agent` 分组即可折叠展示子代理完整过程，协议一个字节都不用改。
 */
export async function runAgentTurnStreaming(
  input: RunAgentTurnInput,
  onEnvelope: (envelope: Envelope) => void,
  options: EnvelopeEmitterOptions = {},
): Promise<TurnResult> {
  const emitter = new EnvelopeEmitter(options);
  // 子代理专属信封发射器缓存：agent → emitter（每个子代理独立 seq / turn）。
  const childEmitters = new Map<string, EnvelopeEmitter>();

  const emitFor = (agent: string, event: ProtocolEvent): void => {
    if (agent === 'main') {
      onEnvelope(emitter.emit(event));
      return;
    }
    let child = childEmitters.get(agent);
    if (child === undefined) {
      child = new EnvelopeEmitter({
        agent,
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      childEmitters.set(agent, child);
    }
    onEnvelope(child.emit(event));
  };

  // 递归分发：subagent_event → 按其 agent 处理内层事件；内层理论上不可能再是
  // subagent_event（一层深硬限制），此处仍递归处理以防御性保持 agent 正确。
  const dispatch = (event: RuntimeEvent): void => {
    if (event.type === 'subagent_event') {
      const inner = event.event;
      if (inner.type === 'subagent_event') {
        dispatch(inner);
        return;
      }
      for (const protocolEvent of mapRuntimeEvent(inner)) {
        emitFor(event.agent, protocolEvent);
      }
      return;
    }
    for (const protocolEvent of mapRuntimeEvent(event)) {
      emitFor('main', protocolEvent);
    }
  };

  return runAgentTurn(input, dispatch);
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
