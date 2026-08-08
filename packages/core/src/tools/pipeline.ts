import { z } from 'zod';
import type { ApprovalGate } from '../permission/approval';
import type { ApprovalRequestInput } from '../permission/approval';
import type { HookBus } from '../hooks/bus';
import { runPostToolUse, runPreToolUse } from '../hooks/run';
import type { ProtocolEvent } from '../protocol/events';
import { redactSecrets, redactValue } from './redact';
import type { ToolRegistry } from './registry';
import { truncateOutput } from './truncate';
import type { TruncationOptions } from './truncate';
import type {
  SubagentRunner,
  Tool,
  ToolContext,
  TodoUpdate,
  ToolOutcome,
  TruncationInfo,
} from './types';
import { isToolOutcome } from './types';

/**
 * 工具执行管线（design 002 5.1）——0.14.0 全量：
 *
 * ① Resolve → ② Validate → ③ Authorize → ④ PreToolUse → ⑤ Execute
 *          → ⑥ Normalize → ⑦ PostToolUse → ⑧ Record
 *
 * - ③ Authorize（T-033，T-050 接入权限内核）：注入 ApprovalGate 时，闸门先按
 *   PermissionConfig 裁决（allow 直通 / deny 拒绝 / ask 发 approval_request 阻塞
 *   等裁决）；deny → ok:false「被拒绝，别重试同样的操作」（002 5.3 第三类策略性
 *   拒绝，明示模型不要反复触发审批）；read 是否拦截由矩阵决定（缺省不拦）。
 * - ④ PreToolUse / ⑦ PostToolUse（0.14.0）：注入 HookBus 时挂载钩子——④ 可
 *   deny 阻止（理由回喂模型）/ 改写参数（改写后重新校验），⑦ 观察 / 副作用
 *   （恒 continue）；缺省直通（0.13.0 及之前行为）。
 *
 * 失败不是异常（002 5.3 错误即数据）：参数错误 / 权限拒绝 / 钩子拒绝 / 执行错误 /
 * 超时全部归为 `ToolOutcome { ok: false, forModel: <可诊断文本> }` 回喂模型自纠；
 * 只有管线自身的不变量破坏（如重复注册）才以异常形式向上抛（内部错误，不回喂模型）。
 */

/** 一次工具调用请求（来自模型的 tool_use）。 */
export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** 执行环境的注入项（cwd / 项目根 / 已读文件集合 / 已读上报回调）；signal 由管线内部管理，调用方不用给。 */
export interface ToolPipelineContext {
  readonly cwd?: string;
  readonly projectRoot?: string;
  /** 会话 ID（0.14.0 钩子输入契约的一部分：PreToolUse / PostToolUse 透传给钩子）。 */
  readonly sessionId?: string;
  /** 本会话已读文件集合（绝对路径），透传给工具 ctx.readFiles（T-030 防盲写）。 */
  readonly readFiles?: ReadonlySet<string>;
  /** 已读文件上报回调：透传给工具 ctx.onFileRead（read 工具成功读后调用，运行时维护已读集合）。 */
  readonly onFileRead?: (path: string) => void;
  /** 待办更新上报回调：透传给工具 ctx.onTodoUpdate（todo_write 更新清单后调用，运行时维护清单状态与日志）。 */
  readonly onTodoUpdate?: (update: TodoUpdate) => void;
  /**
   * 子代理派发通道（T-120 Task 工具）：透传给工具 ctx.runSubagent——
   * Task 工具 execute 经它派生子代理（独立 runAgentTurn），只拿回最终结论。
   * 缺省不注入（Task 工具返回「子代理不可用」失败结果）。
   */
  readonly runSubagent?: SubagentRunner;
  /** 写入上报回调：透传给工具 ctx.onFileWrite（write/edit 成功落盘后调用，运行时维护写冲突检测）。 */
  readonly onFileWrite?: (path: string) => void;
}

export interface ToolPipelineOptions {
  readonly registry: ToolRegistry;
  /**
   * ③ Authorize：审批闸门（T-033，T-050 起按 PermissionConfig 裁决）。
   * 注入时所有风险的工具调用都经它裁决（gate 内部 decidePermission 先跑，
   * allow 直通 / deny 拒绝 / ask 才发 approval_request）。缺省 = 不拦截
   * （0.2.0 及之前行为；headless/TUI 会注入策略闸门，纯管线测试可注入自建
   * 闸门验证拦截行为）。
   */
  readonly authorize?: ApprovalGate;
  /** 执行超时（毫秒）。默认 60_000。超时归为失败结果回喂模型。 */
  readonly timeoutMs?: number;
  /** 外部中断信号：与超时合并后传给工具 ctx.signal。 */
  readonly abortSignal?: AbortSignal;
  /** 截断上限，缺省用 truncate.ts 默认值。 */
  readonly truncate?: TruncationOptions;
  /** 执行上下文（cwd 等）。 */
  readonly context?: ToolPipelineContext;
  /**
   * 钩子总线（0.14.0，design 002 5.1 ④⑦ 挂载点）：提供时，④ PreToolUse
   * （deny 阻止执行且理由回喂模型 / 可改写参数）、⑦ PostToolUse（观察 /
   * 副作用，如编辑后自动 format）挂载钩子。缺省 = 直通（0.13.0 及之前行为）。
   */
  readonly hooks?: HookBus;
  /** ⑧ Record：协议事件出口。缺省静默（不发事件）。 */
  readonly emit?: (event: ProtocolEvent) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** 给人看的结果摘要：取 forModel 首个非空行，超长截断。 */
const SUMMARY_MAX_CHARS = 200;

/** 构造一个失败结果（ok:false + 给模型的可诊断文本）。 */
function failure(forModel: string): ToolOutcome {
  return { ok: false, forModel };
}

/** 异常 → 可诊断文本：带异常名（非通用 Error 时）与消息。 */
function formatError(caught: unknown): string {
  if (caught instanceof Error) {
    return caught.name !== 'Error'
      ? `${caught.name}: ${caught.message}`
      : caught.message;
  }
  return String(caught);
}

/** tool_result 的 summary 缺省值：forModel 首个非空行。 */
function deriveSummary(forModel: string): string {
  const firstLine = forModel
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? forModel.trim()).slice(0, SUMMARY_MAX_CHARS);
}

/** 未知工具的可诊断错误：列出可用工具，提示核对拼写。 */
function unknownToolOutcome(name: string, registry: ToolRegistry): ToolOutcome {
  const names = registry.names();
  const hint =
    names.length === 0
      ? '（当前注册表中没有可用工具）'
      : names.map((n) => `"${n}"`).join('、');
  return failure(
    `未知工具 "${name}"：不在工具注册表中。可用工具：${hint}。请核对工具名后重试。`,
  );
}

/** 参数校验失败的错误：逐字段列明原因，并附正确用法（JSON Schema）。 */
function validationFailureOutcome(tool: Tool, error: z.ZodError): ToolOutcome {
  return failure(
    `参数校验失败（工具 "${tool.name}"）：入参不符合其声明的 schema。\n${formatValidationIssues(
      error,
    )}\n正确用法（JSON Schema）：\n${JSON.stringify(
      z.toJSONSchema(tool.schema),
    )}\n请按正确用法修正参数后重试。`,
  );
}

/** zod 校验错误 → 逐字段问题清单（参数校验失败 / 钩子改写校验共用）。 */
function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '(根)' : issue.path.join('.');
      return `  - ${path}：${issue.message}`;
    })
    .join('\n');
}

/**
 * 钩子改写参数未通过校验的失败结果（④ PreToolUse 改写后重新校验）。
 * 与原参数校验失败同样逐字段列明原因；文案点名「钩子改写」以便模型理解
 * 问题出在钩子侧而非模型侧。
 */
function hookRewriteValidationOutcome(
  tool: Tool,
  error: z.ZodError,
): ToolOutcome {
  return failure(
    `参数校验失败（工具 "${tool.name}"）：PreToolUse 钩子改写的参数不符合其声明的 schema。\n${formatValidationIssues(
      error,
    )}\n钩子改写不合法，请按正确用法重新调用工具。`,
  );
}

/**
 * 构造审批请求输入（③ Authorize）：从工具名与已校验参数推导描述与记忆前缀。
 * - bash：command 作为描述与记忆前缀（危险命令黑名单据此检测）；
 * - 带 path 的工具：按 risk 区分「读取/写入/编辑」描述，path 作为记忆前缀；
 * - args 原样透传：decidePermission（T-050/T-051）据 args.command 判危险、据
 *   args.path 做目录边界 realpath 归一（跟随符号链接 / 解析 `..` / 展开 `~`）；
 * - 描述先过 redactSecrets：命令里可能夹带密钥（`echo sk-…`），不能原样
 *   进 approval_request 事件流 / 会话日志（002 5.4 密钥脱敏）。
 */
function buildApprovalInput(tool: Tool, args: unknown): ApprovalRequestInput {
  let command: string | undefined;
  let prefix: string | undefined;
  let description: string;

  if (typeof args === 'object' && args !== null) {
    const record = args as Record<string, unknown>;
    if (typeof record.command === 'string') {
      command = record.command;
      prefix = record.command;
      description = `执行命令：${redactSecrets(record.command)}`;
    } else if (typeof record.path === 'string') {
      prefix = record.path;
      description =
        tool.risk === 'read'
          ? `读取文件：${redactSecrets(record.path)}`
          : `写入/编辑文件：${redactSecrets(record.path)}`;
    } else {
      description = `调用工具 ${tool.name}（risk: ${tool.risk}）`;
    }
  } else {
    description = `调用工具 ${tool.name}（risk: ${tool.risk}）`;
  }

  return {
    toolName: tool.name,
    risk: tool.risk,
    description,
    ...(command !== undefined ? { command } : {}),
    ...(prefix !== undefined ? { prefix } : {}),
    // T-050/T-051：已校验参数透传给权限裁决（危险命令 / 目录边界 realpath 归一）
    ...(typeof args === 'object' && args !== null
      ? { args: args as Record<string, unknown> }
      : {}),
  };
}

/**
 * 策略性拒绝的可诊断文本（002 5.3 第三类「权限拒绝」）：
 * 必须明示「被拒绝，别重试同样的操作」，否则模型会换个写法反复触发审批把用户烦死。
 */
function denialOutcome(tool: Tool): ToolOutcome {
  return failure(
    `工具 "${tool.name}" 的调用被拒绝（权限审批，${tool.risk} 级操作需经审批）。` +
      `被拒绝，别重试同样的操作；也不要换写法反复触发审批——` +
      `如需继续，请向用户说明你要做什么，等待用户明确同意后再调用。`,
  );
}

/**
 * ⑤ Execute：带超时 + 组合 AbortSignal。
 *
 * 组合信号 = 内部超时控制器 + 外部 abort 信号；工具可监听 ctx.signal 做
 * 协作式取消。即使工具不配合（不监听、永不返回），超时计时器也会按时裁决——
 * 迟到的成功/失败结果被 settled 守卫丢弃，绝不产生未处理的拒绝。
 */
function executeWithTimeout(
  tool: Tool,
  args: unknown,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
  context: ToolPipelineContext,
): Promise<ToolOutcome> {
  return new Promise<ToolOutcome>((resolve) => {
    const controller = new AbortController();
    let timedOut = false;
    let settled = false;

    const settle = (outcome: ToolOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    // 超时计时器：标记超时 → 中止组合信号 → 立即裁决（工具不协作也能按时返回）
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('工具执行超时', 'TimeoutError'));
      settle(
        failure(
          `工具 "${tool.name}" 执行超时（超过 ${timeoutMs}ms）：已中止。若为批量或分页操作，请缩小范围后重试。`,
        ),
      );
    }, timeoutMs);

    // 外部中断信号接入组合信号
    if (abortSignal !== undefined) {
      if (abortSignal.aborted) {
        controller.abort(abortSignal.reason);
      } else {
        abortSignal.addEventListener(
          'abort',
          () => controller.abort(abortSignal.reason),
          { once: true },
        );
      }
    }

    const toolContext: ToolContext = {
      signal: controller.signal,
      ...(context.cwd !== undefined ? { cwd: context.cwd } : {}),
      ...(context.projectRoot !== undefined
        ? { projectRoot: context.projectRoot }
        : {}),
      ...(context.readFiles !== undefined
        ? { readFiles: context.readFiles }
        : {}),
      ...(context.onFileRead !== undefined
        ? { onFileRead: context.onFileRead }
        : {}),
      ...(context.onTodoUpdate !== undefined
        ? { onTodoUpdate: context.onTodoUpdate }
        : {}),
      ...(context.runSubagent !== undefined
        ? { runSubagent: context.runSubagent }
        : {}),
      ...(context.onFileWrite !== undefined
        ? { onFileWrite: context.onFileWrite }
        : {}),
    };

    // Promise.resolve 包裹：工具同步抛错（接口违约）也走 .catch → settle，
    // 保证 tool_result 配对且定时器被清理，不产生未处理拒绝。
    Promise.resolve()
      .then(() => tool.execute(args, toolContext))
      .then((value) => {
        settle(
          isToolOutcome(value)
            ? value
            : failure(
                `工具 "${tool.name}" 返回了非法结果：execute 必须返回 ToolOutcome（含 ok 与 forModel）。`,
              ),
        );
      })
      .catch((caught: unknown) => {
        if (timedOut) return; // 超时已裁决，丢弃迟到的拒绝
        if (controller.signal.aborted) {
          settle(
            failure(`工具 "${tool.name}" 执行被中断（收到外部 abort 信号）。`),
          );
          return;
        }
        settle(failure(`工具 "${tool.name}" 执行出错：${formatError(caught)}`));
      });
  });
}

/** 合并工具自报的截断信息与管线 Normalize 的截断信息。 */
function mergeTruncation(
  toolInfo: TruncationInfo | undefined,
  pipelineInfo: TruncationInfo,
): TruncationInfo {
  if (toolInfo === undefined || !toolInfo.truncated) return pipelineInfo;
  if (!pipelineInfo.truncated) return toolInfo;
  return {
    truncated: true,
    omittedLines:
      (toolInfo.omittedLines ?? 0) + (pipelineInfo.omittedLines ?? 0),
    omittedChars:
      (toolInfo.omittedChars ?? 0) + (pipelineInfo.omittedChars ?? 0),
  };
}

/**
 * ⑥ Normalize：脱敏 + 截断。
 * 顺序是「先脱敏、后截断」：如果先截断，超长密钥可能被截断边界切开而漏过
 * 脱敏正则，反而把残缺密钥喂给模型 / 落盘。payload 同样递归脱敏。
 */
function normalizeOutcome(
  outcome: ToolOutcome,
  truncate: TruncationOptions | undefined,
): ToolOutcome {
  const redactedForModel = redactSecrets(outcome.forModel);
  const { text, info } = truncateOutput(redactedForModel, truncate);
  return {
    ...outcome,
    forModel: text,
    payload:
      outcome.payload !== undefined ? redactValue(outcome.payload) : undefined,
    truncated: mergeTruncation(outcome.truncated, info),
  };
}

/** ⑧ Record：把结果发成 tool_result 协议事件（成功与失败都发）。 */
function emitToolResult(
  emit: (event: ProtocolEvent) => void,
  id: string,
  outcome: ToolOutcome,
): void {
  emit({
    type: 'tool_result',
    data: {
      id,
      ok: outcome.ok,
      summary: outcome.summary ?? deriveSummary(outcome.forModel),
      forModel: outcome.forModel,
      ...(outcome.payload !== undefined ? { payload: outcome.payload } : {}),
    },
  });
}

/**
 * 管线主入口：执行一次工具调用，发出 tool_call / tool_result 协议事件，
 * 返回归一后的 ToolOutcome（错误即数据：ok:false 的文本可直接回喂模型自纠）。
 */
export async function runToolPipeline(
  call: ToolCallRequest,
  options: ToolPipelineOptions,
): Promise<ToolOutcome> {
  const { registry } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const emit = options.emit ?? (() => {});

  // ⑧ Record 前半：tool_call（入参先脱敏，再进事件流 / 日志）
  emit({
    type: 'tool_call',
    data: { id: call.id, name: call.name, input: redactValue(call.input) },
  });

  // ① Resolve：按名查注册表，未知工具回可诊断错误
  const tool = registry.find(call.name);
  if (tool === undefined) {
    const outcome = unknownToolOutcome(call.name, registry);
    emitToolResult(emit, call.id, outcome);
    return outcome;
  }

  // ② Validate：zod 校验参数，失败回正确用法
  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) {
    const outcome = validationFailureOutcome(tool, parsed.error);
    emitToolResult(emit, call.id, outcome);
    return outcome;
  }

  // ③ Authorize（T-033/T-050）：注入审批闸门时，所有风险的工具调用都经它裁决——
  // 闸门内部先跑 decidePermission（T-050 矩阵），allow 直通、deny 拒绝、
  // ask 才发 approval_request；未注入 permission 时闸门保持 0.3.0 行为
  // （read/network 不拦、write/exec 全问）。deny → 策略性拒绝
  // （「被拒绝，别重试」，002 5.3 第三类），不再进入执行；事件流：
  // tool_call → [approval_request → approval_resolved] → tool_result（ok:false）。
  if (options.authorize !== undefined) {
    const decision = await options.authorize.requestApproval(
      buildApprovalInput(tool, parsed.data),
      emit,
    );
    if (decision === 'deny') {
      const outcome = denialOutcome(tool);
      emitToolResult(emit, call.id, outcome);
      return outcome;
    }
  }

  // ④ PreToolUse（0.14.0 挂载点，design 002 5.1）：注入钩子总线时——
  // 任一钩子 deny → 阻止执行，deny 理由原样回喂模型（策略性拒绝：别重试
  // 同样的操作）；钩子改写参数 → 用改写后的参数执行（改写不合法时按参数
  // 校验失败回喂模型，点名问题在钩子侧），并补发一条说明性 notice（前端可
  // 见：实际执行与模型请求不一致）。审计口径：tool_call 事件与会话日志记录
  // 的是**原始请求**（模型实际调用的形态），改写只作用于执行侧——文档不
  // 再声称「记录改写后的形态」（见 hooks/types.ts 的 modifiedInput 注释）。
  // 缺省 = 直通（0.13.0 及之前行为）。
  let args = parsed.data;
  if (options.hooks !== undefined) {
    const pre = await runPreToolUse(options.hooks, {
      ...(options.context?.cwd !== undefined
        ? { cwd: options.context.cwd }
        : {}),
      ...(options.context?.sessionId !== undefined
        ? { sessionId: options.context.sessionId }
        : {}),
      // 外部中断信号透传：turn 的 abortSignal → 钩子进程（abort 时终止进程组
      // 并按 failBehavior 降级，见 executor.ts）
      ...(options.abortSignal !== undefined
        ? { signal: options.abortSignal }
        : {}),
      toolName: tool.name,
      toolInput: parsed.data,
    });
    if (pre.decision === 'deny') {
      const reason =
        pre.reasons.length > 0 ? pre.reasons.join('\n') : '钩子未说明理由';
      const outcome = failure(
        `工具 "${tool.name}" 的调用被钩子拒绝（PreToolUse）。\n原因：${reason}\n被拒绝，别重试同样的操作；如需继续，请先向用户说明你要做什么，等待用户明确同意后再调用。`,
      );
      emitToolResult(emit, call.id, outcome);
      return outcome;
    }
    if (pre.modifiedInput !== undefined) {
      const reparsed = tool.schema.safeParse(pre.modifiedInput);
      if (!reparsed.success) {
        const outcome = hookRewriteValidationOutcome(tool, reparsed.error);
        emitToolResult(emit, call.id, outcome);
        return outcome;
      }
      args = reparsed.data;
      // 偏离 D：改写发生时补发说明性 notice——前端可见「实际执行与模型请求
      // 不一致」。tool_call 事件已按原始请求发出（审计 = 模型请求的形态），
      // 此 notice 补足改写侧的可观测性（不静默）。
      emit({
        type: 'notice',
        data: {
          level: 'info',
          text: `PreToolUse 钩子改写了工具 "${tool.name}" 的入参——实际执行与模型请求不完全一致，请留意`,
        },
      });
    }
  }

  // ⑤ Execute：带超时 + 组合 AbortSignal
  const rawOutcome = await executeWithTimeout(
    tool,
    args,
    timeoutMs,
    options.abortSignal,
    options.context ?? {},
  );

  // ⑥ Normalize：截断 + 脱敏（先脱敏后截断，见 normalizeOutcome 注释）
  const outcome = normalizeOutcome(rawOutcome, options.truncate);

  // ⑦ PostToolUse（0.14.0 挂载点）：注入钩子总线时执行观察 / 副作用钩子
  // （如编辑后自动 format）。结果已产生、无法撤销——PostToolUse 恒 continue，
  // 钩子崩溃/降级只落执行日志（executor 侧），不影响本结果与事件流。
  if (options.hooks !== undefined) {
    await runPostToolUse(options.hooks, {
      ...(options.context?.cwd !== undefined
        ? { cwd: options.context.cwd }
        : {}),
      ...(options.context?.sessionId !== undefined
        ? { sessionId: options.context.sessionId }
        : {}),
      // 外部中断信号透传：turn 的 abortSignal → 钩子进程（同 ④ PreToolUse）
      ...(options.abortSignal !== undefined
        ? { signal: options.abortSignal }
        : {}),
      toolName: tool.name,
      toolInput: args,
      toolResult: { ok: outcome.ok, forModel: outcome.forModel },
    });
  }

  // ⑧ Record 后半：tool_result
  emitToolResult(emit, call.id, outcome);
  return outcome;
}
