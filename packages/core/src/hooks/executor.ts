/**
 * 钩子执行器（T-141）：把外部进程钩子（HookProcessSpec）包装成总线可运行的
 * `Hook`——JSON 契约走 stdin/stdout，带超时与失败降级，每次执行落执行日志。
 *
 * 与总线（T-140 bus.ts）的分工：总线只做注册与编排，不感知进程；执行器把进程
 * 世界翻译成 `HookResult`——崩溃绝不向上抛，按钩子声明的失败策略（ADR 0013）
 * 归为降级结果：
 *
 * - `fail-open`（缺省）：钩子挂了放行（proceed / allow / continue）——格式化 /
 *   观察类钩子不会因为自己的故障拖死任务；
 * - `fail-closed`（PreToolUse 缺省）：钩子挂了拦截（deny / block）——安全钩子
 *   的防护不能因为钩子静默失败而消失（否则用户以为有防护，其实早就失效了）。
 *
 * JSON 契约（第二个对外契约，与事件流协议一样**只能加字段**）：
 *
 *   输入（写 stdin，单行 JSON）：
 *     { v: 1, point, sessionId?, cwd?, toolName?, toolInput?, toolResult?, prompt? }
 *   输出（读 stdout，单行 JSON，按 point 校验）：
 *     SessionStart     { decision: 'proceed' | 'block', reason? }
 *     UserPromptSubmit { decision: 'allow' | 'block', reason?, additionalContext? }
 *     PreToolUse       { decision: 'allow' | 'deny', reason?, modifiedInput? }
 *     PostToolUse      { decision: 'continue', reason? }
 *
 * 进程模型（ADR 0005 同款）：每次调用独立子进程（detached 进程组 + kill(-pid)
 * 终止整组，避免超时留下孤儿）；win32 用 taskkill /T /F。外部中断（abort
 * 信号）同样终止整组，并按 failBehavior 降级（reason 说明「收到中断信号」）。
 * 单流输出上限（默认 64 KiB 字符）内内存有界。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { Hook, HookContext, HookPoint, HookResult } from './types';
import type { HookExecutionLog } from './log';

// ---------------------------------------------------------------------------
// 规格与协议
// ---------------------------------------------------------------------------

/** 一次外部进程钩子的执行规格（settings.json hooks 配置条目解析后的形态）。 */
export interface HookProcessSpec {
  /** 可执行命令（绝对路径或 PATH 内命令；不支持 shell 语法——命令拆分执行）。 */
  readonly command: string;
  /** 命令行参数。 */
  readonly args?: readonly string[];
  /** 超时（毫秒；缺省 5000）。超时按 failBehavior 降级并终止进程组。 */
  readonly timeoutMs?: number;
  /**
   * 失败降级策略（ADR 0013）：fail-open = 崩溃放行，fail-closed = 崩溃拦截。
   * 缺省按钩子点：PreToolUse（deny 语义的安全钩子）缺省 fail-closed，
   * 其余点缺省 fail-open。
   */
  readonly failBehavior?: 'fail-open' | 'fail-closed';
  /** 追加的环境变量（继承进程环境，此项覆盖）。 */
  readonly env?: Readonly<Record<string, string>>;
}

/** 写入钩子进程 stdin 的 JSON 输入（对外契约，只加字段）。 */
export interface HookProcessInput {
  /** 协议版本（本版恒 1）。 */
  readonly v: 1;
  readonly point: HookPoint;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly toolResult?: { readonly ok: boolean; readonly forModel?: string };
  readonly prompt?: string;
}

/** 一次钩子进程执行的产出：结果 + 是否降级（G-0.14.0 验收门「可查日志」）。 */
export interface HookInvocationResult {
  /** 最终裁决（降级时是 failBehavior 兜底的结果，reason 说明原因）。 */
  readonly result: HookResult;
  /** 是否降级（超时 / 崩溃 / 非法输出）。 */
  readonly degraded: boolean;
  /** 降级原因（未降级时为 undefined）。 */
  readonly degradedReason?: string;
  /** 进程退出码（进程被杀 / spawn 失败时为 null）。 */
  readonly exitCode?: number | null;
  /** 进程 stderr 摘要 / 异常信息（诊断用）。 */
  readonly error?: string;
}

/** runHookProcess / processHook 的选项。 */
export interface HookProcessOptions {
  /** 钩子注册 ID（执行日志的钩子标识；总线包装时由注册方注入）。 */
  readonly hookId: string;
  /** 执行日志（缺省不记录）。 */
  readonly log?: HookExecutionLog;
  /** 外部中断信号（触发时按超时语义终止进程组并降级）。 */
  readonly signal?: AbortSignal;
  /** 工作目录（缺省 process.cwd()）。 */
  readonly cwd?: string;
  /** 会话 ID（透传给输入；缺省由调用方在 context 里提供）。 */
  readonly sessionId?: string;
  /** 时钟注入口（测试用；缺省 Date.now）。 */
  readonly now?: () => number;
}

/** 钩子进程默认超时（毫秒）：脚本型钩子应快速裁决，慢钩子拖死 agent 不可接受。 */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;
/** 单流（stdout / stderr）输出累积上限（字符）：内存有界，超出只计数不缓冲。 */
export const HOOK_OUTPUT_CAP_CHARS = 64 * 1024;
/** SIGTERM 后升级 SIGKILL 的宽限期（毫秒）。 */
const KILL_ESCALATE_MS = 300;

/**
 * 失败降级策略缺省（ADR 0013）：deny 语义的安全钩子（PreToolUse）缺省
 * fail-closed——防护不能因为钩子静默失败而消失；其余（观察 / 注入 / 提交类）
 * 缺省 fail-open——钩子的故障不该拖死任务。
 */
export function defaultFailBehavior(
  point: HookPoint,
): 'fail-open' | 'fail-closed' {
  return point === 'PreToolUse' ? 'fail-closed' : 'fail-open';
}

// ---------------------------------------------------------------------------
// 输出校验（各钩子点的 JSON 契约；宽松——允许多余字段，向前兼容）
// ---------------------------------------------------------------------------

const sessionStartSchema = z.object({
  decision: z.enum(['proceed', 'block']),
  reason: z.string().optional(),
});
const userPromptSubmitSchema = z.object({
  decision: z.enum(['allow', 'block']),
  reason: z.string().optional(),
  additionalContext: z.string().optional(),
});
const preToolUseSchema = z.object({
  decision: z.enum(['allow', 'deny']),
  reason: z.string().optional(),
  modifiedInput: z.unknown().optional(),
});
const postToolUseSchema = z.object({
  decision: z.literal('continue'),
  reason: z.string().optional(),
});

/** 按钩子点取输出校验 schema。 */
function schemaFor(point: HookPoint): z.ZodType<HookResult> {
  switch (point) {
    case 'SessionStart':
      return sessionStartSchema as z.ZodType<HookResult>;
    case 'UserPromptSubmit':
      return userPromptSubmitSchema as z.ZodType<HookResult>;
    case 'PreToolUse':
      return preToolUseSchema as z.ZodType<HookResult>;
    case 'PostToolUse':
      return postToolUseSchema as z.ZodType<HookResult>;
  }
}

// ---------------------------------------------------------------------------
// 降级裁决
// ---------------------------------------------------------------------------

/**
 * 降级裁决：进程崩溃 / 超时 / 非法输出时按 failBehavior 兜底。返回的 reason
 * 必须说明「钩子出了什么问题」，否则用户会以为防护仍在（ADR 0013 的要点）。
 */
export function degradedDecision(
  point: HookPoint,
  failBehavior: 'fail-open' | 'fail-closed',
  cause: string,
): HookResult {
  const failClosed = failBehavior === 'fail-closed';
  switch (point) {
    case 'PreToolUse':
      // fail-closed：拦截（防护不消失）；fail-open：放行（钩子故障不阻塞任务）
      return failClosed
        ? {
            decision: 'deny',
            reason: `钩子执行失败（fail-closed 降级拦截）：${cause}`,
          }
        : {
            decision: 'allow',
            reason: `钩子执行失败（fail-open 降级放行）：${cause}`,
          };
    case 'UserPromptSubmit':
      return failClosed
        ? {
            decision: 'block',
            reason: `钩子执行失败（fail-closed 降级阻止提交）：${cause}`,
          }
        : {
            decision: 'allow',
            reason: `钩子执行失败（fail-open 降级放行）：${cause}`,
          };
    case 'PostToolUse':
      // 工具结果已产生，无法撤销；降级只记录 + 带理由 continue
      return {
        decision: 'continue',
        reason: `钩子执行失败（${failBehavior} 降级）：${cause}`,
      };
    case 'SessionStart':
      return failClosed
        ? {
            decision: 'block',
            reason: `钩子执行失败（fail-closed 降级阻止启动）：${cause}`,
          }
        : {
            decision: 'proceed',
            reason: `钩子执行失败（fail-open 降级放行）：${cause}`,
          };
  }
}

// ---------------------------------------------------------------------------
// 进程执行
// ---------------------------------------------------------------------------

/** 终止整个进程组（ADR 0005 同款）：POSIX kill(-pid)，win32 taskkill /T /F。 */
function killProcessGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, sig);
  } catch {
    // 进程组可能已退出——忽略
  }
}

/** 单流累积器：上限内缓冲，超出只计数（内存有界）。 */
interface StreamAcc {
  readonly cap: number;
  buf: string;
  dropped: number;
}

function createAcc(cap: number): StreamAcc {
  return { cap, buf: '', dropped: 0 };
}

function pushAcc(acc: StreamAcc, text: string): void {
  if (acc.buf.length >= acc.cap) {
    acc.dropped += text.length;
    return;
  }
  const room = acc.cap - acc.buf.length;
  acc.buf += text.slice(0, room);
  if (text.length > room) acc.dropped += text.length - room;
}

/** stderr 摘录（诊断 / 日志用）：首行 + 溢出计数，单行截断到 200 字符。 */
function summarizeStderr(acc: StreamAcc): string | undefined {
  const trimmed = acc.buf.trim();
  if (trimmed.length === 0 && acc.dropped === 0) return undefined;
  const firstLine = trimmed.split('\n')[0] ?? '';
  const line = firstLine.slice(0, 200);
  const overflow = acc.dropped > 0 ? `（另有 ${acc.dropped} 字符被丢弃）` : '';
  return `${line}${overflow}`;
}

/** 从 stdout 解析并校验钩子输出；解析失败返回 undefined（按降级处理）。 */
function parseOutput(point: HookPoint, stdout: string): HookResult | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const result = schemaFor(point).safeParse(parsed);
  return result.success ? (result.data as HookResult) : undefined;
}

/**
 * 执行一次外部进程钩子：写 JSON 进 stdin → 收 stdout/stderr（有界）→ 超时 /
 * 崩溃 / 非法输出按 failBehavior 降级 → 落执行日志。返回恰好一次，不抛异常。
 */
export async function runHookProcess(
  point: HookPoint,
  input: HookProcessInput,
  spec: HookProcessSpec,
  options: HookProcessOptions,
): Promise<HookInvocationResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const failBehavior = spec.failBehavior ?? defaultFailBehavior(point);
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const cwd = options.cwd ?? process.cwd();

  const invocation = await new Promise<HookInvocationResult>(
    (resolvePromise) => {
      const stdoutAcc = createAcc(HOOK_OUTPUT_CAP_CHARS);
      const stderrAcc = createAcc(HOOK_OUTPUT_CAP_CHARS);
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let spawnFailed:
        { readonly code?: string; readonly message: string } | undefined;

      let child: ChildProcess;
      try {
        child = spawn(spec.command, spec.args ?? [], {
          cwd,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...spec.env },
          windowsHide: true,
        });
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : String(caught);
        resolvePromise({
          result: degradedDecision(
            point,
            failBehavior,
            `spawn 失败：${message}`,
          ),
          degraded: true,
          degradedReason: `spawn 失败：${message}`,
          exitCode: null,
          error: message,
        });
        return;
      }

      let escalateTimer: ReturnType<typeof setTimeout> | undefined;

      const terminateGroup = (): void => {
        killProcessGroup(child, 'SIGTERM');
        escalateTimer = setTimeout(() => {
          if (!settled) killProcessGroup(child, 'SIGKILL');
        }, KILL_ESCALATE_MS);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminateGroup();
      }, timeoutMs);

      const onAbort = (): void => {
        if (settled) return;
        aborted = true;
        terminateGroup();
      };

      const settle = (result: HookInvocationResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (escalateTimer !== undefined) clearTimeout(escalateTimer);
        options.signal?.removeEventListener('abort', onAbort);
        resolvePromise(result);
      };

      if (options.signal !== undefined) {
        options.signal.addEventListener('abort', onAbort, { once: true });
        if (options.signal.aborted) onAbort();
      }

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => pushAcc(stdoutAcc, chunk));
      child.stderr?.on('data', (chunk: string) => pushAcc(stderrAcc, chunk));

      child.on('error', (caught) => {
        const message =
          caught instanceof Error ? caught.message : String(caught);
        spawnFailed = { code: (caught as { code?: string }).code, message };
      });

      child.on('close', (exitCode, exitSignal) => {
        if (settled) return;
        const stderrSummary = summarizeStderr(stderrAcc);

        // 外部中断（abort）：进程组已被终止，按 failBehavior 降级（reason 说明
        // 是中断而非钩子自身故障——用户能看到「钩子被打断」而不是无声降级）。
        if (aborted) {
          settle({
            result: degradedDecision(
              point,
              failBehavior,
              '收到外部中断信号（abort），已终止进程组',
            ),
            degraded: true,
            degradedReason: '收到外部中断信号（abort），已终止进程组',
            exitCode,
            error: stderrSummary,
          });
          return;
        }
        // 超时 / spawn 失败 / 非零退出 → 降级
        if (timedOut) {
          settle({
            result: degradedDecision(
              point,
              failBehavior,
              `超时（超过 ${timeoutMs}ms），已终止进程组`,
            ),
            degraded: true,
            degradedReason: `超时（超过 ${timeoutMs}ms），已终止进程组`,
            exitCode,
            error: stderrSummary,
          });
          return;
        }
        if (spawnFailed !== undefined) {
          settle({
            result: degradedDecision(
              point,
              failBehavior,
              `spawn 失败（${spawnFailed.code ?? 'unknown'}）：${spawnFailed.message}`,
            ),
            degraded: true,
            degradedReason: `spawn 失败（${spawnFailed.code ?? 'unknown'}）：${spawnFailed.message}`,
            exitCode: null,
            error: spawnFailed.message,
          });
          return;
        }
        const parsed = parseOutput(point, stdoutAcc.buf);
        if (parsed === undefined) {
          const cause =
            exitCode === 0
              ? 'stdout 不是合法的本点 JSON 输出'
              : `退出码 ${exitCode ?? '?'}${exitSignal ? `（信号 ${exitSignal}）` : ''}`;
          settle({
            result: degradedDecision(point, failBehavior, cause),
            degraded: true,
            degradedReason: cause,
            exitCode,
            error: stderrSummary,
          });
          return;
        }
        settle({
          result: parsed,
          degraded: false,
          exitCode,
          ...(stderrSummary !== undefined ? { error: stderrSummary } : {}),
        });
      });

      // 写入输入 JSON 并关闭 stdin（钩子进程据此结束读取、产出裁决）
      const payload = `${JSON.stringify(input)}\n`;
      try {
        child.stdin?.write(payload, 'utf8', () => {
          child.stdin?.end();
        });
      } catch (caught) {
        // 进程可能在写入前已退出（spawn 失败由 'close' 兜底）；忽略写入错误
        const message =
          caught instanceof Error ? caught.message : String(caught);
        settle({
          result: degradedDecision(
            point,
            failBehavior,
            `stdin 写入失败：${message}`,
          ),
          degraded: true,
          degradedReason: `stdin 写入失败：${message}`,
          exitCode: null,
          error: message,
        });
        return;
      }
    },
  );

  // —— 执行日志（JSONL 旁路）：超时 / 崩溃 / 非法输出落 degraded: true ——
  await options.log?.append({
    type: 'hook',
    point,
    hookId: options.hookId,
    command: [spec.command, ...(spec.args ?? [])].join(' '),
    ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
    durationMs: now() - startedAt,
    decision: invocation.result.decision,
    degraded: invocation.degraded,
    ...(invocation.result.reason !== undefined
      ? { reason: invocation.result.reason }
      : {}),
    ...(invocation.exitCode !== undefined
      ? { exitCode: invocation.exitCode }
      : {}),
    ...(invocation.error !== undefined ? { error: invocation.error } : {}),
  });

  return invocation;
}

/** 把 HookContext 投影为进程 JSON 输入（只带契约字段，不泄漏总线内部）。 */
function projectInput(
  point: HookPoint,
  context: HookContext,
): HookProcessInput {
  return {
    v: 1,
    point,
    ...(context.sessionId !== undefined
      ? { sessionId: context.sessionId }
      : {}),
    ...(context.cwd !== undefined ? { cwd: context.cwd } : {}),
    ...(context.toolName !== undefined ? { toolName: context.toolName } : {}),
    ...(context.toolInput !== undefined
      ? { toolInput: context.toolInput }
      : {}),
    ...(context.toolResult !== undefined
      ? { toolResult: context.toolResult }
      : {}),
    ...(context.prompt !== undefined ? { prompt: context.prompt } : {}),
  };
}

/**
 * 把进程钩子规格包装成总线可注册的 `Hook`（T-141 的对外接口）：
 * 每次执行走 runHookProcess（JSON 契约 + 超时 + 降级 + 日志），结果按 failBehavior
 * 归位——进程崩溃绝不向上抛。
 */
export function processHook(
  spec: HookProcessSpec,
  options: HookProcessOptions,
): Hook {
  return async (context: HookContext): Promise<HookResult> => {
    // 外部中断信号：运行期透传的 context.signal（turn 的 abortSignal，经
    // HookBus.run 注入）优先，回落到注册时注入的 options.signal。
    const signal = context.signal ?? options.signal;
    const invocation = await runHookProcess(
      context.point,
      projectInput(context.point, context),
      spec,
      {
        hookId: options.hookId,
        ...(options.log !== undefined ? { log: options.log } : {}),
        ...(signal !== undefined ? { signal } : {}),
        cwd: options.cwd ?? context.cwd,
        ...(context.sessionId !== undefined
          ? { sessionId: context.sessionId }
          : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      },
    );
    return invocation.result;
  };
}
