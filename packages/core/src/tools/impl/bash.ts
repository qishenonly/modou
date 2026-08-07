import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { truncateOutput } from '../truncate';
import type { TruncationInfo } from '../types';
import type { Tool, ToolContext, ToolOutcome } from '../types';

/**
 * Bash 工具（T-032）：在 shell 中执行命令（risk: exec）。
 *
 * 设计依据（docs/design/002-architecture.md 5.2 / 5.3 / 5.4，进程模型见 ADR 0005）：
 * - **每次调用独立子进程 + 显式 cwd**（ADR 0005 决策）：不持久 shell，cd / source /
 *   export 只影响本次命令，跨调用不生效——简单、无状态污染、并发调用互不干扰；
 * - **进程组终止**：POSIX 下以 `detached: true`（setsid）让子进程成为独立进程组组长，
 *   超时 / 中断按 `kill(-pid)` 终止**整个进程组**（含命令派生的孙子进程），避免孤儿；
 *   win32 下用 `taskkill /pid <pid> /T /F` 递归终止进程树；
 * - **超时**：默认 30s、上限 5 分钟（schema 校验）；超时先 SIGTERM、300ms 后升级 SIGKILL，
 *   返回可诊断结果并说明「已终止进程组」；ctx.signal（管线全局超时 / 外部中断）同样触发
 *   进程组终止，配合管线保证不泄漏子进程；
 * - **错误即数据**：命令退出非零是**正常的结果反馈**（回喂退出码 + stdout/stderr，模型据此
 *   自纠，工具不抛异常）；spawn 失败（shell 缺失 / cwd 不存在）与超时 / 中断是**工具执行
 *   出错**（payload.error 分类 + 可诊断文本），两者明确区分；
 * - **输出治理**：stdout / stderr 分流收集（payload 各持一份），forModel 合并展示且 stderr
 *   以 `[stderr]` 标记区分；单流累积上限（默认 256 KiB 字符）内内存有界，超出只计数不缓冲；
 *   再复用 tools/truncate.ts 做「截断要出声」——保留头尾、写明省略行数 / 字符数（002 5.4），
 *   截断信息随 outcome.truncated 与 payload.truncated 上报，管线合并；密钥脱敏由管线
 *   Normalize 统一处理，工具不重复。
 *
 * 实现要点：spawn 成功后以「'error' / 'close' 先到先裁决 + settled 守卫」保证恰好一次
 * 返回；'error'（spawn 失败）与 'close'（进程结束、stdio 已关闭、数据收全）都会触发裁决。
 */

/** Bash 工具默认超时（毫秒）。 */
export const BASH_TIMEOUT_DEFAULT = 30_000;
/** Bash 工具超时上限：单条命令最多执行 5 分钟，超出请拆分任务（毫秒）。 */
export const BASH_TIMEOUT_MAX = 5 * 60_000;
/** 单流（stdout / stderr）输出累积上限（字符，UTF-16 码元）：内存有界，超出只计数不缓冲。 */
export const BASH_OUTPUT_CAP_CHARS = 256 * 1024;
/** SIGTERM 后升级 SIGKILL 的宽限期（毫秒）：命令若捕获 SIGTERM 不退出，强制杀死。 */
const KILL_ESCALATE_MS = 300;

/** Bash 工具参数 schema（zod）：command 必填；cwd / timeoutMs 可选。 */
export const bashSchema = z.object({
  command: z.string().min(1, 'command 不能为空字符串'),
  cwd: z.string().min(1, 'cwd 不能为空字符串').optional(),
  timeoutMs: z
    .number()
    .int('timeoutMs 必须是整数')
    .positive('timeoutMs 必须是正整数')
    .max(
      BASH_TIMEOUT_MAX,
      `timeoutMs 最大支持 ${BASH_TIMEOUT_MAX}ms（5 分钟），超出请拆分任务`,
    )
    .optional(),
});

export type BashArgs = z.infer<typeof bashSchema>;

/**
 * Bash 结构化载荷（成功与错误共用）。
 * 注意 error 字段的语义：命令退出非零**不算**工具层错误（那是正常的错误即数据，
 * 由 exitCode + stdout/stderr 表达）；error 只覆盖「工具执行出错」：spawn 失败、
 * 超时、中断、被信号终止。
 */
export interface BashPayload {
  readonly command: string;
  /** 进程退出码；spawn 失败 / 被信号终止时为空。 */
  readonly exitCode: number | null;
  /** 终止进程的信号（被信号终止时存在）。 */
  readonly signal?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly truncated?: TruncationInfo;
  readonly error?:
    'spawn_failed' | 'timeout' | 'interrupted' | 'killed_by_signal';
  /** spawn 失败时的系统错误码（如 ENOENT / EACCES）。 */
  readonly errorCode?: string;
  /** 超时触发时本次生效的超时（毫秒）。 */
  readonly timeoutMs?: number;
}

/** 工具选项：允许测试与特化场景覆盖默认值。 */
export interface BashToolOptions {
  /** 覆盖 shell 路径（默认按平台解析）。测试注入不存在的路径以模拟 spawn 失败。 */
  readonly shellPath?: string;
  /** 未传 timeoutMs 时的默认超时（毫秒）。默认 BASH_TIMEOUT_DEFAULT。 */
  readonly defaultTimeoutMs?: number;
  /** 单流输出累积上限（字符）。默认 BASH_OUTPUT_CAP_CHARS。 */
  readonly outputCapChars?: number;
}

/** 解析后的运行时选项（默认值已展开）。 */
interface BashRuntimeOptions {
  readonly shellPath?: string;
  readonly defaultTimeoutMs: number;
  readonly outputCapChars: number;
}

/** 一次进程运行的结果（错误分类为 payload.error 的输入）。 */
interface BashRunResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** 截断后的 stdout 文本。 */
  readonly stdout: string;
  /** 截断后的 stderr 文本。 */
  readonly stderr: string;
  readonly truncated: TruncationInfo;
  readonly error?: BashPayload['error'];
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly timeoutMs?: number;
}

/** 单流累积器：字符上限内保留，超出只计数不缓冲（内存有界、截断出声）。 */
interface StreamAcc {
  readonly cap: number;
  /** 已累积文本（≤ cap 字符）。 */
  buf: string;
  /** 超过上限丢弃的字符数。 */
  droppedChars: number;
  /** 已见换行总数（含丢弃部分）。 */
  newlines: number;
}

function createAcc(cap: number): StreamAcc {
  return { cap, buf: '', droppedChars: 0, newlines: 0 };
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) n += 1;
  }
  return n;
}

/** 追加一段文本：上限内缓冲，超出只累计丢弃的字符与换行数。 */
function pushAcc(acc: StreamAcc, text: string): void {
  acc.newlines += countNewlines(text);
  if (acc.buf.length >= acc.cap) {
    acc.droppedChars += text.length;
    return;
  }
  const room = acc.cap - acc.buf.length;
  acc.buf += text.slice(0, room);
  if (text.length > room) acc.droppedChars += text.length - room;
}

/** 收尾：对缓冲文本做「截断要出声」处理，并把溢出丢弃的部分并入截断信息。 */
function finalizeAcc(acc: StreamAcc): {
  readonly text: string;
  readonly info: TruncationInfo;
} {
  const bufferedNewlines = countNewlines(acc.buf);
  const droppedLines = Math.max(0, acc.newlines - bufferedNewlines);
  const { text, info } = truncateOutput(acc.buf);
  if (acc.droppedChars === 0 && droppedLines === 0) return { text, info };
  return {
    text,
    info: {
      truncated: true,
      ...(droppedLines + (info.omittedLines ?? 0) > 0
        ? { omittedLines: droppedLines + (info.omittedLines ?? 0) }
        : {}),
      ...(acc.droppedChars + (info.omittedChars ?? 0) > 0
        ? { omittedChars: acc.droppedChars + (info.omittedChars ?? 0) }
        : {}),
    },
  };
}

/** 合并多个流（stdout / stderr）的截断信息。 */
function mergeTruncationInfos(
  infos: readonly TruncationInfo[],
): TruncationInfo {
  let truncated = false;
  let omittedLines = 0;
  let omittedChars = 0;
  for (const info of infos) {
    truncated = truncated || info.truncated;
    if (info.omittedLines !== undefined) omittedLines += info.omittedLines;
    if (info.omittedChars !== undefined) omittedChars += info.omittedChars;
  }
  if (!truncated) return { truncated: false };
  return {
    truncated: true,
    ...(omittedLines > 0 ? { omittedLines } : {}),
    ...(omittedChars > 0 ? { omittedChars } : {}),
  };
}

/** shell 调用形态：shell 路径 + 执行命令的前置参数。 */
interface ShellInvocation {
  readonly shell: string;
  readonly prefix: readonly string[];
}

/** 按平台解析默认 shell（POSIX /bin/bash；win32 用 ComSpec/cmd）。 */
function resolveShell(override?: string): ShellInvocation {
  if (override !== undefined) return { shell: override, prefix: ['-c'] };
  if (process.platform === 'win32') {
    return {
      shell: process.env.ComSpec ?? 'cmd.exe',
      prefix: ['/d', '/s', '/c'],
    };
  }
  return { shell: '/bin/bash', prefix: ['-c'] };
}

/**
 * 终止整个进程组（ADR 0005）：
 * - POSIX：detached（setsid）使 child 成为独立进程组组长，`kill(-pid)` 覆盖组内
 *   全部进程（含命令派生的孙子进程），避免超时 / 中断后留下孤儿；
 * - win32：`taskkill /pid <pid> /T /F` 递归终止进程树（负 pid kill 在 win32 不受支持）。
 */
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

/** 判断中止原因是否为「超时」（管线全局超时以 DOMException TimeoutError 触发 abort）。 */
function isPipelineTimeoutReason(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as { readonly name?: unknown }).name === 'TimeoutError'
  );
}

/** 解析最终 cwd：args.cwd 缺省用 ctx.cwd，仍缺省用 process.cwd()；相对路径相对前者解析。 */
function resolveCwd(args: BashArgs, ctx: ToolContext): string {
  const base = ctx.cwd ?? process.cwd();
  if (args.cwd === undefined) return base;
  return isAbsolute(args.cwd) ? args.cwd : resolve(base, args.cwd);
}

/**
 * 执行一条命令并收集结果。
 *
 * 返回时机：spawn 'error'（进程未创建 / spawn 失败）或 'close'（进程结束且 stdio 已
 * 关闭、数据收全），先到先裁决，settled 守卫保证恰好一次。超时 / 中断走 terminateGroup
 * 终止进程组，随后 'close' 触发裁决并携带「已终止进程组」的分类。
 */
async function runBashCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  invocation: ShellInvocation,
  outputCap: number,
): Promise<BashRunResult> {
  return new Promise<BashRunResult>((resolvePromise) => {
    const stdoutAcc = createAcc(outputCap);
    const stderrAcc = createAcc(outputCap);
    let settled = false;
    let timedOut = false;
    let interruptKind: 'external' | 'pipeline_timeout' | undefined;
    let spawnFailed:
      { readonly code?: string; readonly message: string } | undefined;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;

    // 同步 spawn：创建子进程（detached 使其成为独立进程组组长，可整体终止）
    let child: ChildProcess;
    try {
      child = spawn(invocation.shell, [...invocation.prefix, command], {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        windowsHide: true,
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      resolvePromise({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: { truncated: false },
        error: 'spawn_failed',
        errorMessage: message,
      });
      return;
    }

    let escalateTimer: ReturnType<typeof setTimeout> | undefined;

    /** 终止进程组：先 SIGTERM，宽限期后未退出升级 SIGKILL（防止命令捕获 SIGTERM 拖死）。 */
    const terminateGroup = (): void => {
      killProcessGroup(child, 'SIGTERM');
      escalateTimer = setTimeout(() => {
        if (!settled) killProcessGroup(child, 'SIGKILL');
      }, KILL_ESCALATE_MS);
    };

    /** 超时计时器：到点标记超时并终止进程组（超时裁决在 'close' 时完成）。 */
    const timer = setTimeout(() => {
      timedOut = true;
      terminateGroup();
    }, timeoutMs);

    /** 管线全局超时 / 外部中断：终止进程组，返回时携带中断分类（区分超时与人为中断）。 */
    const onAbort = (): void => {
      if (settled) return;
      interruptKind = isPipelineTimeoutReason(signal.reason)
        ? 'pipeline_timeout'
        : 'external';
      terminateGroup();
    };

    /** 恰好一次裁决：清理计时器与监听器。 */
    const settle = (result: BashRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalateTimer !== undefined) clearTimeout(escalateTimer);
      signal.removeEventListener('abort', onAbort);
      resolvePromise(result);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => pushAcc(stdoutAcc, chunk));
    child.stderr?.on('data', (chunk: string) => pushAcc(stderrAcc, chunk));

    /** 裁决驱动：按「spawn 失败 > 超时 > 中断 > 被信号终止 > 正常退出」分类。 */
    const finish = (): void => {
      if (settled) return;
      const { text: stdout, info: stdoutInfo } = finalizeAcc(stdoutAcc);
      const { text: stderr, info: stderrInfo } = finalizeAcc(stderrAcc);
      const truncated = mergeTruncationInfos([stdoutInfo, stderrInfo]);

      if (spawnFailed !== undefined) {
        settle({
          exitCode: null,
          signal: null,
          stdout,
          stderr,
          truncated,
          error: 'spawn_failed',
          errorCode: spawnFailed.code,
          errorMessage: spawnFailed.message,
        });
        return;
      }
      if (timedOut) {
        settle({
          exitCode: null,
          signal: exitSignal,
          stdout,
          stderr,
          truncated,
          error: 'timeout',
          timeoutMs,
        });
        return;
      }
      if (interruptKind !== undefined) {
        settle({
          exitCode: null,
          signal: exitSignal,
          stdout,
          stderr,
          truncated,
          error: 'interrupted',
        });
        return;
      }
      if (exitCode === null) {
        // 无退出码（被信号终止或极端情况）：归为 killed_by_signal
        settle({
          exitCode: null,
          signal: exitSignal,
          stdout,
          stderr,
          truncated,
          error: 'killed_by_signal',
        });
        return;
      }
      settle({ exitCode, signal: exitSignal, stdout, stderr, truncated });
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      spawnFailed = { code: err.code, message: err.message };
      finish();
    });

    child.on('close', (code, sig) => {
      if (settled) return;
      exitCode = code;
      exitSignal = sig ?? null;
      finish();
    });
  });
}

/** stdout / stderr 合并展示：stderr 以 [stderr] 标记区分（002 5.4「同一结果两种表示」）。 */
function mergeOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.length > 0) parts.push(stdout);
  if (stderr.length > 0) parts.push(`[stderr]\n${stderr}`);
  return parts.join('\n');
}

/** 摘要用：命令首行，超长截断加省略号。 */
function shortCommand(command: string, max = 60): string {
  const firstLine = command.split('\n', 1)[0] ?? command;
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

/** 失败结果（错误即数据）：可诊断文本 + 给人看的摘要 + 结构化载荷 + 截断信息。 */
function fail(
  forModel: string,
  summary: string,
  payload: unknown,
  truncated?: TruncationInfo,
): ToolOutcome {
  return {
    ok: false,
    forModel,
    summary,
    payload,
    ...(truncated !== undefined && truncated.truncated ? { truncated } : {}),
  };
}

/** 由运行结果构造 ToolOutcome：区分「命令退出非零」（正常错误即数据）与工具执行出错。 */
function buildOutcome(args: BashArgs, result: BashRunResult): ToolOutcome {
  const body = mergeOutput(result.stdout, result.stderr);
  const payload: BashPayload = {
    command: args.command,
    exitCode: result.exitCode,
    ...(result.signal !== null ? { signal: result.signal } : {}),
    ...(result.stdout.length > 0 ? { stdout: result.stdout } : {}),
    ...(result.stderr.length > 0 ? { stderr: result.stderr } : {}),
    ...(result.truncated.truncated ? { truncated: result.truncated } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    ...(result.timeoutMs !== undefined ? { timeoutMs: result.timeoutMs } : {}),
  };
  const cmd = shortCommand(args.command);

  if (result.error === 'spawn_failed') {
    return fail(
      `命令执行失败：无法启动 shell（${result.errorMessage ?? '未知错误'}${result.errorCode !== undefined ? `，系统错误码 ${result.errorCode}` : ''}）。\n` +
        `请确认 shell（${resolveShell().shell}）可用、cwd 存在且可访问，再修正后重试。`,
      `Bash ${cmd}：无法启动 shell`,
      payload,
      result.truncated,
    );
  }
  if (result.error === 'timeout') {
    return fail(
      `命令执行超时（超过 ${result.timeoutMs}ms）：已终止整个进程组。\n` +
        `${body.length > 0 ? `已捕获的部分输出：\n${body}` : '无部分输出。'}\n` +
        `命令可能运行过长或阻塞等待输入。可增大 timeoutMs，或将任务拆小分步执行。`,
      `Bash ${cmd}：超时，已终止进程组`,
      payload,
      result.truncated,
    );
  }
  if (result.error === 'interrupted') {
    return fail(
      `命令执行被中断（收到外部中断 / 全局超时信号）：已终止整个进程组。\n` +
        `${body.length > 0 ? `已捕获的部分输出：\n${body}` : '无部分输出。'}`,
      `Bash ${cmd}：被中断，已终止进程组`,
      payload,
      result.truncated,
    );
  }
  if (result.error === 'killed_by_signal') {
    return fail(
      `命令被信号 ${result.signal ?? '未知'} 终止（非工具主动终止，可能是命令自身杀死了自己）。\n` +
        `${body.length > 0 ? `已捕获的输出：\n${body}` : '无输出。'}`,
      `Bash ${cmd}：被信号 ${result.signal ?? '未知'} 终止`,
      payload,
      result.truncated,
    );
  }
  if (result.exitCode !== 0) {
    return fail(
      `命令执行失败（退出码 ${result.exitCode}）。${body.length > 0 ? `\n${body}` : '无输出。'}\n` +
        `退出非零是命令本身的结果反馈（不是工具故障），请根据 stderr / 退出码修正命令后重试。`,
      `Bash ${cmd}：退出码 ${result.exitCode}（失败）`,
      payload,
      result.truncated,
    );
  }
  const text =
    body.length > 0
      ? `命令执行成功（退出码 0）。\n──\n${body}`
      : '命令执行成功（退出码 0），无输出。';
  return {
    ok: true,
    forModel: text,
    summary: `Bash ${cmd}：退出码 0`,
    payload,
    ...(result.truncated.truncated ? { truncated: result.truncated } : {}),
  };
}

/** 执行一次 Bash 调用（由 createBashTool 闭包注入运行时选项）。 */
async function executeBash(
  args: BashArgs,
  ctx: ToolContext,
  options: BashRuntimeOptions,
): Promise<ToolOutcome> {
  const cwd = resolveCwd(args, ctx);
  const timeoutMs = args.timeoutMs ?? options.defaultTimeoutMs;
  const invocation = resolveShell(options.shellPath);
  const result = await runBashCommand(
    args.command,
    cwd,
    timeoutMs,
    ctx.signal,
    invocation,
    options.outputCapChars,
  );
  return buildOutcome(args, result);
}

/** 构造 Bash 工具（可用选项覆盖默认值 / 注入 shell 路径；测试用）。 */
export function createBashTool(
  options: BashToolOptions = {},
): Tool<typeof bashSchema> {
  const runtime: BashRuntimeOptions = {
    ...(options.shellPath !== undefined
      ? { shellPath: options.shellPath }
      : {}),
    defaultTimeoutMs: options.defaultTimeoutMs ?? BASH_TIMEOUT_DEFAULT,
    outputCapChars: options.outputCapChars ?? BASH_OUTPUT_CAP_CHARS,
  };
  return {
    name: 'bash',
    description:
      '在 shell 中执行命令（风险等级：exec，调用前需经权限审批，请只运行必要且安全的命令）。' +
      'command 必填：要执行的命令字符串（经 shell 执行，支持管道、重定向、&&/||、变量等语法）；' +
      'cwd 可选：命令的工作目录（默认当前工作目录；相对路径相对当前工作目录解析）；' +
      'timeoutMs 可选：超时毫秒（默认 30000，最大 300000，超时后终止整个进程组）。' +
      '每次调用都是独立的子进程，环境不跨调用保留：cd / source / export 只影响本次命令，' +
      '跨命令不生效——如需在特定目录运行请显式传 cwd。' +
      'stdout 与 stderr 合并返回（stderr 以 [stderr] 标记区分）；超长输出会截断并写明省略行数。' +
      '命令退出非零会连同退出码与 stderr 一起返回（ok:false，属正常结果反馈，模型应据此修正命令）；' +
      'spawn 失败 / 超时 / 中断会明确说明并终止进程组。',
    schema: bashSchema,
    risk: 'exec',
    execute: (args: BashArgs, ctx: ToolContext) =>
      executeBash(args, ctx, runtime),
  };
}

/** 默认 Bash 工具实例（T-032，risk: exec）。 */
export const bashTool: Tool<typeof bashSchema> = createBashTool();
