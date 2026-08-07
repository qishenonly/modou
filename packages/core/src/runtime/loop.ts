import type {
  ModelMessage,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ToolSet,
} from 'ai';
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
import type { ApprovalGate } from '../permission/approval';
import type {
  ApprovalDecision,
  ApprovalOption,
  RiskLevel,
} from '../protocol/events';
import { runToolPipeline } from '../tools/pipeline';
import { redactValue } from '../tools/redact';
import type { ToolRegistry } from '../tools/registry';
import { toToolSet } from '../tools/toolset';
import { extractInterruptReason, isInterruptError } from './interrupt';
import { withRetry } from './retry';
import type { RetryOptions } from './retry';
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
  /**
   * 供应商错误的指数退避重试参数（T-014）。缺省用默认值（最多 3 次尝试）。
   * 重试发生在 provider 流内（单轮内），详见 retry.ts。
   */
  readonly retry?: RetryOptions;
}

export interface RunAgentTurnInput {
  readonly provider: ModelProvider;
  readonly system?: string;
  /** 对话消息（AI SDK ModelMessage 规范格式）。loop 只追加自己的副本，不改入参。 */
  readonly messages: ModelMessage[];
  /**
   * 工具注册表：提供时，streamChat 把注册表转成 AI SDK ToolSet 传给模型
   * （模型能看到工具定义、能发出 tool_use），tool_use 一律走执行管线
   * （runToolPipeline——管线对未注册工具产出 ok:false 且列出可用工具名）；
   * 未提供时模型看不到任何工具，仍收到 tool_use 则按「未知工具」回喂。
   */
  readonly tools?: ToolRegistry;
  /**
   * 会话级已读文件集合（绝对路径，Write/Edit 防盲写的生产者种子）：
   * 调用方/headless 传入会话既有的已读状态，或缺省新建（空集合）。
   * loop 会把它复制成内部可变集合并持续维护——Read 工具成功读到的文件
   * 经 ctx.onFileRead 回调实时入集，集合跨轮次持续（同一会话内 Read 过
   * 即可 Edit/Write 覆盖）；tools 拿到的始终是当前累计的只读快照。
   */
  readonly readFiles?: ReadonlySet<string>;
  /** 工作目录：传给工具 ctx.cwd（相对路径以此解析）。缺省 process.cwd()。 */
  readonly cwd?: string;
  /**
   * 审批闸门（T-033）：提供时，管线 ③ Authorize 对 write / exec 工具调用它
   * （发 approval_request 阻塞等裁决，deny → 策略性拒绝回喂）。read 不拦。
   * 缺省 = 管线不拦截（0.2.0 及之前行为）。headless 按策略装配并注入。
   */
  readonly approval?: ApprovalGate;
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
 * Runtime 内部事件流。T-013 把这里的每个事件映射为协议层信封
 * （turn_start / turn_end / text_delta / thinking_delta / tool_call / usage /
 * error / notice）。`tool_feedback` 是 runtime 层事件：仅在「未提供工具
 * 注册表」时标识「未知工具」错误已回喂模型（提供注册表时未知工具由管线
 * 产出 tool_result，见下）。`tool_result` 由工具管线（⑧ Record）的执行结果
 * 转换而来，携带与人看的 tool_result 协议事件一致的负载（id / ok / summary /
 * forModel / payload），bridge 直接映射为协议 tool_result。
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
  | {
      readonly type: 'tool_result';
      readonly id: string;
      readonly ok: boolean;
      readonly summary: string;
      readonly forModel?: string;
      readonly payload?: unknown;
    }
  | {
      readonly type: 'approval_request';
      readonly id: string;
      readonly description: string;
      readonly risk: RiskLevel;
      readonly options: readonly ApprovalOption[];
    }
  | {
      readonly type: 'approval_resolved';
      readonly id: string;
      readonly decision: ApprovalDecision;
      readonly source: 'user' | 'rule' | 'policy';
    }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'error'; readonly error: ProviderError }
  | {
      readonly type: 'turn_end';
      readonly turn: number;
      readonly termination: TurnTermination;
    };

/** 未提供工具注册表时的回喂文案：模型看不到任何工具定义却发了工具调用。 */
const UNKNOWN_TOOL_MESSAGE = (name: string): string =>
  `未知工具 "${name}"：当前会话未提供工具注册表，无法执行任何工具调用。请勿调用工具，直接用文本回答用户。`;

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
 *    - `tool_use` → executing：tools 提供时（注册与否）一律经 runToolPipeline
 *      执行并回喂，未注册工具由管线产出 ok:false + 可用工具列表；tools 未提供
 *      才保留「未知工具」错误回喂（见 feedBackToolRound）；
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
  const {
    provider,
    system,
    messages,
    tools,
    options,
    readFiles: initialReadFiles,
    cwd: inputCwd,
    approval,
  } = input;
  const { maxTurns, maxTokens, abortSignal } = options;
  const emit = onEvent ?? (() => {});

  /**
   * 会话级已读文件集合（Write/Edit 防盲写的生产者）：
   * 从入参复制（或缺省新建），Read 工具成功读到的文件路径经 onFileRead
   * 回调实时加入；集合跨轮次持续——同一会话内 Read 过即可 Edit/Write 覆盖。
   */
  const readFiles = new Set<string>(initialReadFiles ?? []);
  /** 工作目录：入参提供或缺省 process.cwd()，传给工具 ctx.cwd。 */
  const cwd = inputCwd ?? process.cwd();

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

  /**
   * 回喂一轮的工具结果（assistant tool-call → tool 结果，AI SDK ModelMessage
   * 规范格式，与 0.1.0 验证过的构造方式一致）：提供工具注册表时，tool_use
   * 一律经 runToolPipeline 执行（注册与否都由管线归一——未注册工具产出
   * ok:false 且列出可用工具名）；未提供注册表才按「未知工具」错误回喂。
   * 管线发出的协议事件在此转成 RuntimeEvent 透出（tool_call 跳过，见
   * executeToolCall 内注释）。
   */
  const feedBackToolRound = async (
    roundText: string,
    toolUses: ReadonlyArray<{ id: string; name: string; input: unknown }>,
    tools: ToolRegistry | undefined,
  ): Promise<void> => {
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

    const results: ToolResultPart[] = [];
    for (const call of toolUses) {
      if (tools === undefined) {
        // 未提供注册表：模型看不到任何工具定义却发了 tool_use，
        // 保留「未知工具」错误回喂（含 tool_feedback 事件）
        emit({
          type: 'tool_feedback',
          id: call.id,
          name: call.name,
          error: UNKNOWN_TOOL_MESSAGE(call.name),
        });
        results.push({
          type: 'tool-result',
          toolCallId: call.id,
          toolName: call.name,
          output: {
            type: 'error-text',
            value: UNKNOWN_TOOL_MESSAGE(call.name),
          },
        });
      } else {
        // 提供注册表（无论该工具是否注册）：一律走管线。未注册工具由
        // 管线产出 ok:false + 可用工具列表，比 loop 自己的弱诊断更可诊断。
        results.push(await executeToolCall(call, tools));
      }
    }
    thread.push({ role: 'tool', content: results });
  };

  /**
   * 通过工具管线执行一次工具调用，返回 AI SDK 的 tool-result 消息片段。
   *
   * 管线 ⑧ Record 的协议事件在此转成 RuntimeEvent：
   * - `tool_call` 跳过——流式阶段已由 `tool_use` 事件经 bridge 映射为协议
   *   tool_call（入参已在透出时脱敏，见上方 tool_use 分支），再转发会同一
   *   调用出现两条 tool_call；
   * - `tool_result` 转成 RuntimeEvent，由 bridge 映射为协议 tool_result
   *   （summarizer / 双表示字段原样保留）。
   *
   * 管线不抛 ProviderError：中断 / 超时 / 执行错误一律归一为 `ok:false`
   * 的 ToolOutcome 回喂模型自纠；turn 级中断语义由 abortSignal 透传保证——
   * 中止信号已置位时，管线中断工具、下一轮 provider 请求立即以 aborted
   * 失败，loop 照常转 interrupted。
   */
  const executeToolCall = async (
    call: { id: string; name: string; input: unknown },
    tools: ToolRegistry,
  ): Promise<ToolResultPart> => {
    const outcome = await runToolPipeline(
      { id: call.id, name: call.name, input: call.input },
      {
        registry: tools,
        abortSignal,
        // ③ Authorize（T-033）：write / exec 工具经审批闸门（read 不拦）。
        // 缺省不拦截（调用方未注入时保持 0.2.0 行为）。
        authorize: approval,
        // 执行上下文：cwd 供相对路径解析；readFiles 供 Write/Edit 防盲写检查；
        // onFileRead 是已读集合的唯一生产者——read 工具成功读到一个文件后
        // 回调，loop 据此把该文件（realpath 已由 read 工具解析）加入会话集合，
        // 使同轮或后续轮次的 Write/Edit 放行。集合跨轮次持续。
        context: {
          cwd,
          readFiles,
          onFileRead: (path) => {
            readFiles.add(path);
          },
        },
        emit: (pipelineEvent) => {
          if (pipelineEvent.type === 'tool_result') {
            const { id, ok, summary, forModel, payload } = pipelineEvent.data;
            emit({
              type: 'tool_result',
              id,
              ok,
              summary,
              ...(forModel !== undefined ? { forModel } : {}),
              ...(payload !== undefined ? { payload } : {}),
            });
          } else if (pipelineEvent.type === 'approval_request') {
            // 审批请求事件：bridge 据此映射为协议 approval_request（弹窗等裁决）
            const { id, description, risk, options } = pipelineEvent.data;
            emit({
              type: 'approval_request',
              id,
              description,
              risk,
              options,
            });
          } else if (pipelineEvent.type === 'approval_resolved') {
            // 审批裁决收尾：bridge 据此映射为协议 approval_resolved（关闭弹窗）
            const { id, decision, source } = pipelineEvent.data;
            emit({ type: 'approval_resolved', id, decision, source });
          }
        },
      },
    );
    return {
      type: 'tool-result',
      toolCallId: call.id,
      toolName: call.name,
      output: outcome.ok
        ? { type: 'text', value: outcome.forModel }
        : { type: 'error-text', value: outcome.forModel },
    };
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

  // 工具注册表 → AI SDK v7 ToolSet：模型能看到工具定义、能发出 tool_use 的
  // 关键一环（G-0.2.0）。注册表缺失时不传（模型没有工具可用）。
  const toolSet: ToolSet | undefined =
    tools === undefined ? undefined : toToolSet(tools);

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
      // 供应商错误（429 / 5xx / 超时）由 withRetry 按指数退避重试：
      // 只有尚未产出事件的失败才整体重试，已产出部分内容则直接按错误
      // 终止（保留已产文本）；退避期间 abort 也能立刻停下（干净中断）。
      const stream = withRetry(
        () =>
          provider.streamChat({
            system,
            messages: thread,
            // 工具定义随请求发给模型：真实模型据此发出 tool_use（G-0.2.0）。
            // 注册表缺失时不传（模型没有工具可用）。
            ...(toolSet === undefined ? {} : { tools: toolSet }),
            abortSignal,
          }),
        {
          ...options.retry,
          abortSignal: abortSignal ?? options.retry?.abortSignal,
        },
      );
      for await (const event of stream) {
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
            // 转发为协议 tool_call 前先脱敏入参（与管线 ⑧ Record 的脱敏语义
            // 一致），避免模型入参里的密钥原样透出到事件流 / 会话日志。
            emit({
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: redactValue(event.input),
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
        // streaming --tool_use--> executing：tools 提供时一律走执行管线
        // （未注册工具由管线产出 ok:false + 可用工具列表）；未提供注册表
        // 保留「未知工具」回喂（见 feedBackToolRound）
        move('tool_use');
        await feedBackToolRound(roundText, toolUses, tools);
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
