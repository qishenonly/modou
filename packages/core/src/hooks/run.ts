/**
 * 钩子聚合函数（T-142 拦截与改写）：把 HookBus 的原始结果（HookOutcome[]）翻译成
 * 管线 / 前端可消费的语义。每个钩子点的聚合语义：
 *
 * - `runPreToolUse`：任一钩子 deny → 整体 deny（理由回喂模型，可多条；deny 无
 *   reason 时补缺省文案，绝不因钩子忘了写理由而静默放行）；均 allow 时取**最后
 *   一个**钩子改写的参数（modifiedInput，注册顺序靠后的有最终话语权）；内联钩子
 *   崩溃（非进程钩子）按保守策略视为 deny——PreToolUse 是 deny 语义的安全钩子点，
 *   防护不能因为钩子静默失败而消失（进程钩子崩溃已在执行器层按 failBehavior
 *   降级，此处只兜底内联钩子）。最终判定：`denied || errors.length > 0`。
 * - `runPostToolUse`：恒 continue（观察 / 副作用，不改变工具结果）；崩溃记录在
 *   errors（执行器已落日志，这里不打断管线）。
 * - `runUserPromptSubmit`：任一钩子 block → 整体 block（首个 block 理由）；均
 *   allow 时拼接各钩子的附加上下文（多段换行合并）。
 * - `runSessionStart`：任一钩子 block → block（本版只提供挂载点，未接线）。
 */

import type { HookBus } from './bus';
import type { HookOutcome } from './types';

/** 内联钩子崩溃的诊断文本（聚合进 reasons / 日志，不打断批次）。 */
function describeErrors(errors: readonly unknown[]): string {
  return errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join('；');
}

// ---------------------------------------------------------------------------
// PreToolUse（④）
// ---------------------------------------------------------------------------

/** PreToolUse 聚合：deny 阻止 / allow 放行（可带改写参数）。 */
export interface PreToolUseAggregate {
  readonly decision: 'allow' | 'deny';
  /** deny 时回喂模型的理由（每条钩子一句，按注册顺序）。 */
  readonly reasons: readonly string[];
  /** 改写后的工具参数（allow 时才有；取最后一个改写的钩子）。 */
  readonly modifiedInput?: unknown;
  /** 内联钩子崩溃记录（进程钩子已在执行器层降级，这里只兜底内联钩子）。 */
  readonly errors: readonly unknown[];
}

/** 执行 PreToolUse 钩子并聚合为管线可消费的裁决。 */
export async function runPreToolUse(
  bus: HookBus,
  context: {
    readonly sessionId?: string;
    readonly cwd?: string;
    readonly toolName: string;
    readonly toolInput: unknown;
  },
): Promise<PreToolUseAggregate> {
  const outcomes = await bus.run('PreToolUse', {
    point: 'PreToolUse',
    ...(context.sessionId !== undefined
      ? { sessionId: context.sessionId }
      : {}),
    ...(context.cwd !== undefined ? { cwd: context.cwd } : {}),
    toolName: context.toolName,
    toolInput: context.toolInput,
  });
  return aggregatePreToolUse(outcomes);
}

/** 纯聚合（可注入预跑的 outcomes 测试；崩溃按 deny 保守兜底）。 */
export function aggregatePreToolUse(
  outcomes: readonly HookOutcome[],
): PreToolUseAggregate {
  const reasons: string[] = [];
  const errors: unknown[] = [];
  let modifiedInput: unknown;
  let denied = false;
  for (const outcome of outcomes) {
    if (outcome.error !== undefined) {
      errors.push(outcome.error);
      continue;
    }
    const result = outcome.result;
    if (result === undefined) continue;
    if (result.decision === 'deny') {
      denied = true;
      if (result.reason !== undefined && result.reason.length > 0) {
        reasons.push(result.reason);
      } else {
        // deny 无 reason：补缺省文案（防护不因钩子忘了写理由而静默失效）
        reasons.push('钩子未说明理由（deny 无 reason，按拦截处理）');
      }
    } else if ('modifiedInput' in result) {
      // `in` 收窄：只有 PreToolUse 结果带 modifiedInput；最后一个改写的钩子
      // 有最终话语权（注册顺序靠后覆盖靠前）
      const modified = result.modifiedInput;
      if (modified !== undefined) modifiedInput = modified;
    }
  }
  // 内联钩子崩溃：PreToolUse 是 deny 语义的安全点，保守按拦截处理（fail-closed）
  if (errors.length > 0) {
    reasons.push(
      `钩子执行失败（内联钩子崩溃，按拦截处理）：${describeErrors(errors)}`,
    );
  }
  // 最终判定：任一 deny（无论是否带理由）或内联崩溃 → deny
  if (denied || errors.length > 0) {
    return { decision: 'deny', reasons, errors };
  }
  return {
    decision: 'allow',
    reasons,
    ...(modifiedInput !== undefined ? { modifiedInput } : {}),
    errors,
  };
}

// ---------------------------------------------------------------------------
// PostToolUse（⑦）
// ---------------------------------------------------------------------------

/** PostToolUse 聚合：恒 continue（观察 / 副作用，不改变工具结果）。 */
export interface PostToolUseAggregate {
  readonly decision: 'continue';
  /** 内联钩子崩溃记录（不打断管线；进程钩子已由执行器落日志）。 */
  readonly errors: readonly unknown[];
}

/** 执行 PostToolUse 钩子并聚合（观察 / 副作用，不改变工具结果）。 */
export async function runPostToolUse(
  bus: HookBus,
  context: {
    readonly sessionId?: string;
    readonly cwd?: string;
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly toolResult: { readonly ok: boolean; readonly forModel?: string };
  },
): Promise<PostToolUseAggregate> {
  const outcomes = await bus.run('PostToolUse', {
    point: 'PostToolUse',
    ...(context.sessionId !== undefined
      ? { sessionId: context.sessionId }
      : {}),
    ...(context.cwd !== undefined ? { cwd: context.cwd } : {}),
    toolName: context.toolName,
    toolInput: context.toolInput,
    toolResult: context.toolResult,
  });
  const errors: unknown[] = [];
  for (const outcome of outcomes) {
    if (outcome.error !== undefined) errors.push(outcome.error);
  }
  return { decision: 'continue', errors };
}

// ---------------------------------------------------------------------------
// UserPromptSubmit
// ---------------------------------------------------------------------------

/** UserPromptSubmit 聚合：allow（可注入附加上下文）/ block（阻止提交）。 */
export interface UserPromptSubmitAggregate {
  readonly decision: 'allow' | 'block';
  /** block 时的理由（首个 block 钩子的理由，对用户展示）。 */
  readonly reason?: string;
  /** 附加上下文：所有 allow 钩子的附加段换行拼接（插入到用户提示词之后）。 */
  readonly additionalContext?: string;
}

/** 执行 UserPromptSubmit 钩子并聚合：任一 block → 阻止；否则拼接注入上下文。 */
export async function runUserPromptSubmit(
  bus: HookBus,
  prompt: string,
  context: { readonly sessionId?: string; readonly cwd?: string } = {},
): Promise<UserPromptSubmitAggregate> {
  const outcomes = await bus.run('UserPromptSubmit', {
    point: 'UserPromptSubmit',
    ...(context.sessionId !== undefined
      ? { sessionId: context.sessionId }
      : {}),
    ...(context.cwd !== undefined ? { cwd: context.cwd } : {}),
    prompt,
  });
  const injected: string[] = [];
  const errors: unknown[] = [];
  for (const outcome of outcomes) {
    if (outcome.error !== undefined) {
      errors.push(outcome.error);
      continue;
    }
    const result = outcome.result;
    if (result === undefined) continue;
    if (result.decision === 'block') {
      return {
        decision: 'block',
        ...(result.reason !== undefined && result.reason.length > 0
          ? { reason: result.reason }
          : {}),
      };
    }
    // `in` 收窄：只有 UserPromptSubmit 结果带 additionalContext（SessionStart
    // 的 decision 也含 'block'，但本点是 UserPromptSubmit，安全）
    if ('additionalContext' in result) {
      const additional = result.additionalContext;
      if (additional !== undefined && additional.length > 0) {
        injected.push(additional);
      }
    }
  }
  // 内联钩子崩溃：UserPromptSubmit 是 allow 语义点，崩溃不应阻止用户提交
  // （fail-open 语义）；reason 里说明有钩子出问题，调用方据此提示。
  const degraded = errors.length > 0;
  return {
    decision: 'allow',
    ...(injected.length > 0
      ? { additionalContext: injected.join('\n\n') }
      : {}),
    ...(degraded
      ? {
          reason: `钩子执行失败（内联钩子崩溃，放行提交）：${describeErrors(errors)}`,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// SessionStart
// ---------------------------------------------------------------------------

/** SessionStart 聚合：proceed / block（本版只提供挂载点，未接线）。 */
export interface SessionStartAggregate {
  readonly decision: 'proceed' | 'block';
  readonly reason?: string;
}

/** 执行 SessionStart 钩子并聚合：任一 block → block（首个理由）。 */
export async function runSessionStart(
  bus: HookBus,
  context: { readonly sessionId?: string; readonly cwd?: string } = {},
): Promise<SessionStartAggregate> {
  const outcomes = await bus.run('SessionStart', {
    point: 'SessionStart',
    ...(context.sessionId !== undefined
      ? { sessionId: context.sessionId }
      : {}),
    ...(context.cwd !== undefined ? { cwd: context.cwd } : {}),
  });
  const errors: unknown[] = [];
  for (const outcome of outcomes) {
    if (outcome.error !== undefined) {
      errors.push(outcome.error);
      continue;
    }
    const result = outcome.result;
    if (result === undefined) continue;
    if (result.decision === 'block') {
      return {
        decision: 'block',
        ...(result.reason !== undefined && result.reason.length > 0
          ? { reason: result.reason }
          : {}),
      };
    }
  }
  // 内联钩子崩溃：SessionStart 无 fail 语义先例，按 proceed 放行并注明问题
  return {
    decision: 'proceed',
    ...(errors.length > 0
      ? {
          reason: `钩子执行失败（内联钩子崩溃，放行启动）：${describeErrors(errors)}`,
        }
      : {}),
  };
}
