import { z } from 'zod';
import type { ApprovalGate } from '../permission/approval';
import type { ApprovalRequestInput } from '../permission/approval';
import type { ProtocolEvent } from '../protocol/events';
import { redactSecrets, redactValue } from './redact';
import type { ToolRegistry } from './registry';
import { truncateOutput } from './truncate';
import type { TruncationOptions } from './truncate';
import type { Tool, ToolContext, ToolOutcome, TruncationInfo } from './types';
import { isToolOutcome } from './types';

/**
 * 工具执行管线（design 002 5.1）——0.3.0 子集：
 *
 * ① Resolve → ② Validate → ③ Authorize → ⑤ Execute → ⑥ Normalize → ⑧ Record
 *
 * - ③ Authorize（T-033）：write / exec 工具经 ApprovalGate 审批（发 approval_request
 *   阻塞等裁决）；deny → ok:false「被拒绝，别重试同样的操作」（002 5.3 第三类策略性
 *   拒绝，明示模型不要反复触发审批）；read 不拦（0.3.0）。
 * - ④ PreToolUse / ⑦ PostToolUse：0.14.0 在此挂载 hooks。
 *
 * 失败不是异常（002 5.3 错误即数据）：参数错误 / 权限拒绝 / 执行错误 / 超时全部归为
 * `ToolOutcome { ok: false, forModel: <可诊断文本> }` 回喂模型自纠；只有
 * 管线自身的不变量破坏（如重复注册）才以异常形式向上抛（内部错误，不回喂模型）。
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
  /** 本会话已读文件集合（绝对路径），透传给工具 ctx.readFiles（T-030 防盲写）。 */
  readonly readFiles?: ReadonlySet<string>;
  /** 已读文件上报回调：透传给工具 ctx.onFileRead（read 工具成功读后调用，运行时维护已读集合）。 */
  readonly onFileRead?: (path: string) => void;
}

export interface ToolPipelineOptions {
  readonly registry: ToolRegistry;
  /**
   * ③ Authorize：审批闸门（T-033）。write / exec 工具调用前经它审批；
   * read 不拦。缺省 = 不拦截（0.2.0 及之前行为；headless 会注入策略闸门，
   * 纯管线测试可注入自建闸门验证拦截行为）。
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
  const issues = error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '(根)' : issue.path.join('.');
      return `  - ${path}：${issue.message}`;
    })
    .join('\n');
  const usage = JSON.stringify(z.toJSONSchema(tool.schema));
  return failure(
    `参数校验失败（工具 "${tool.name}"）：入参不符合其声明的 schema。\n${issues}\n正确用法（JSON Schema）：\n${usage}\n请按正确用法修正参数后重试。`,
  );
}

/**
 * 构造审批请求输入（③ Authorize）：从工具名与已校验参数推导描述与记忆前缀。
 * - bash：command 作为描述与记忆前缀（危险命令黑名单据此检测）；
 * - 写 / 编辑工具：path 作为描述与记忆前缀；
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
      description = `写入/编辑文件：${redactSecrets(record.path)}`;
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

  // ③ Authorize（T-033）：write / exec 工具经审批闸门；read 不拦（0.3.0）。
  // deny → 策略性拒绝（「被拒绝，别重试」），不再进入执行；事件流：
  // tool_call → approval_request → approval_resolved → tool_result（ok:false）。
  if (
    options.authorize !== undefined &&
    (tool.risk === 'write' || tool.risk === 'exec')
  ) {
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
  // ④ PreToolUse —— 0.14.0 在此挂载钩子（design 002 5.1）

  // ⑤ Execute：带超时 + 组合 AbortSignal
  const rawOutcome = await executeWithTimeout(
    tool,
    parsed.data,
    timeoutMs,
    options.abortSignal,
    options.context ?? {},
  );

  // ⑥ Normalize：截断 + 脱敏（先脱敏后截断，见 normalizeOutcome 注释）
  const outcome = normalizeOutcome(rawOutcome, options.truncate);

  // ⑦ PostToolUse —— 0.14.0 在此挂载钩子

  // ⑧ Record 后半：tool_result
  emitToolResult(emit, call.id, outcome);
  return outcome;
}
