import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * ripgrep 二进制分发与行级运行辅助（T-022 前置；ADR 0004 定稿）。
 *
 * 分发策略（docs/decisions/0004-ripgrep-distribution.md）：
 * - 捆绑优先：`@vscode/ripgrep`（VS Code 团队维护，随平台分发预编译二进制）
 *   导出的 `rgPath`；包缺失（如平台子包未安装）或二进制文件不存在时回退；
 * - 系统兜底：`which rg` 探测 PATH 中的系统 rg；
 * - 两者都不可用：抛 `RgUnavailableError`（可诊断错误），由工具转成
 *   `ok:false` 的错误即数据结果回喂模型自纠。
 *
 * 解析结果进程内缓存，工具首启动探测一次，后续调用零开销。
 * 动态 import 而非静态：平台子包缺失时不会在模块加载期抛错，可优雅回退。
 */

/** 一个可用的 rg 二进制（来源与绝对路径）。 */
export interface RgBinary {
  /** 可执行文件绝对路径。 */
  readonly path: string;
  /** 来源：捆绑（@vscode/ripgrep）/ 系统（PATH 中的 rg）。 */
  readonly source: 'bundled' | 'system';
}

/** rg 不可用（捆绑与系统都找不到）时的可诊断错误，由工具转成 ToolOutcome。 */
export class RgUnavailableError extends Error {
  constructor() {
    super(
      '未找到可用的 ripgrep 二进制：捆绑的 @vscode/ripgrep 不可用，PATH 中也未找到系统 rg。' +
        '请安装系统 ripgrep（如 `apt install ripgrep` / `brew install ripgrep`），' +
        '或确认 @vscode/ripgrep 及其平台子包安装完整后重试。',
    );
    this.name = 'RgUnavailableError';
  }
}

/**
 * 解析注入项（测试用）：显式给值即跳过自动探测；`null` 表示「该来源显式不可用」。
 * 不提供选项时走默认路径（捆绑优先 → 系统兜底），并命中进程内缓存。
 */
export interface RgResolverOptions {
  /** 捆绑路径注入。undefined = 自动探测（@vscode/ripgrep）。 */
  readonly bundledPath?: string | null;
  /** 系统 rg 路径注入。undefined = 自动探测（which）。 */
  readonly systemPath?: string | null;
}

let cached: RgBinary | null | undefined;

/** 自动探测捆绑二进制：@vscode/ripgrep 的 rgPath。包缺失 / 二进制不存在返回 null。 */
async function probeBundled(): Promise<string | null> {
  try {
    const mod = (await import('@vscode/ripgrep')) as {
      readonly rgPath?: unknown;
    };
    if (
      typeof mod.rgPath === 'string' &&
      mod.rgPath.length > 0 &&
      existsSync(mod.rgPath)
    ) {
      return mod.rgPath;
    }
    return null;
  } catch {
    // 包缺失 / 平台子包未安装 / 导入出错：走系统 rg
    return null;
  }
}

/** 自动探测系统 rg：`which rg`。which 不可用或未命中返回 null。 */
function probeSystem(): string | null {
  try {
    const res = spawnSync('which', ['rg'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status === 0) {
      const first = res.stdout.split('\n')[0].trim();
      if (first.length > 0 && existsSync(first)) return first;
    }
  } catch {
    // which 不可用（极端环境）：回落 null
  }
  return null;
}

/** 自动探测组合：捆绑优先，回退系统。 */
async function probeDefault(): Promise<RgBinary | null> {
  const bundled = await probeBundled();
  if (bundled !== null) return { path: bundled, source: 'bundled' };
  const system = probeSystem();
  if (system !== null) return { path: system, source: 'system' };
  return null;
}

/**
 * 查找可用 rg 二进制（返回 null 表示不可用，不抛错）。
 * 注入选项用于测试（模拟捆绑缺失 / 系统缺失 / 全不可用等分支）。
 */
export async function findRgBinary(
  options?: RgResolverOptions,
): Promise<RgBinary | null> {
  if (options !== undefined) {
    // 注入模式：bundledPath / systemPath 各自「显式给值 / 显式 null / 自动探测」
    const bundled =
      options.bundledPath !== null && options.bundledPath !== undefined
        ? options.bundledPath
        : options.bundledPath === undefined
          ? await probeBundled()
          : null;
    if (bundled !== null) return { path: bundled, source: 'bundled' };
    const system =
      options.systemPath !== null && options.systemPath !== undefined
        ? options.systemPath
        : options.systemPath === undefined
          ? probeSystem()
          : null;
    if (system !== null) return { path: system, source: 'system' };
    return null;
  }

  if (cached !== undefined) return cached;
  cached = await probeDefault();
  return cached;
}

/** 查找并返回可用 rg；不可用时抛 RgUnavailableError（可诊断）。 */
export async function resolveRgBinary(
  options?: RgResolverOptions,
): Promise<RgBinary> {
  const binary = await findRgBinary(options);
  if (binary === null) throw new RgUnavailableError();
  return binary;
}

// ---------------------------------------------------------------------------
// 行级运行辅助：spawn rg + 按行回调 stdout + 上限截断（提前杀死子进程）
// ---------------------------------------------------------------------------

/** runRgLines 的选项。 */
export interface RgLineRunOptions {
  /** 组合取消信号（管线超时 / 外部中止）。 */
  readonly signal?: AbortSignal;
  /**
   * 逐行回调（UTF-8 文本）。返回 false 表示「已收集足够（截断）」：
   * 停止读取 stdout 并终止子进程，结果的 stopped 置 true。
   */
  readonly onLine: (line: string) => boolean;
}

/** runRgLines 的结果。 */
export interface RgLineRunResult {
  /** 进程退出码；被我们提前终止时为 null。 */
  readonly exitCode: number | null;
  /** 终止信号（被杀死时存在）。 */
  readonly signalCode: NodeJS.Signals | null;
  /** 捕获的 stderr（有界，最多保留末尾 64 KiB，防超长错误刷爆内存）。 */
  readonly stderr: string;
  /** 是否因 onLine 返回 false 而提前停止（截断）。 */
  readonly stopped: boolean;
}

const STDERR_CAP = 64 * 1024;
/** 退出等待兜底：极端情况下 close 未触发时用当前快照，避免挂起。 */
const EXIT_WAIT_MS = 2_000;

/**
 * 运行 rg 并逐行回调 stdout。设计要点：
 * - readline 按行切分（crlfDelay Infinity 正确吞掉 \r\n），跨块多字节不裂字；
 * - 异步迭代自带背压：回调处理不过来时不会无界缓冲；
 * - 达到上限或收到取消信号即 SIGTERM 终止子进程，不留孤儿；
 * - spawn 失败（如注入路径不可执行）以异常形式向上抛，由调用方诊断。
 */
export async function runRgLines(
  binary: RgBinary,
  args: readonly string[],
  options: RgLineRunOptions,
): Promise<RgLineRunResult> {
  const child = spawn(binary.path, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // spawn 失败必须有监听器，否则 'error' 事件会成为未捕获异常
  child.on('error', () => {
    // stdout 流会以 error 形式让 readline 循环抛错，由调用方转成可诊断结果
  });

  let stderr = '';
  let stopped = false;

  const kill = (): void => {
    try {
      child.kill('SIGTERM');
    } catch {
      // 进程已退出：忽略
    }
  };

  const hasSignal = options.signal !== undefined;
  const onAbort = (): void => {
    kill();
  };
  if (hasSignal) {
    if (options.signal!.aborted) {
      kill();
    } else {
      options.signal!.addEventListener('abort', onAbort, { once: true });
    }
  }

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
  });

  try {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      if (options.signal?.aborted) break; // 外部中止：退出循环
      const cont = options.onLine(line);
      if (!cont) {
        stopped = true;
        kill();
        break;
      }
    }
  } finally {
    if (hasSignal) options.signal!.removeEventListener('abort', onAbort);
  }

  // 等待进程完全退出（close = stdio 全关），拿到退出码与信号
  const exit = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    const timer = setTimeout(() => {
      resolveExit({ code: child.exitCode, signal: child.signalCode });
    }, EXIT_WAIT_MS);
    timer.unref();
    const onClose = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    };
    child.once('close', onClose);
    child.once('error', () => {
      // spawn 失败：close 未必触发，用当前快照兜底
      clearTimeout(timer);
      resolveExit({ code: child.exitCode, signal: child.signalCode });
    });
  });

  return { exitCode: exit.code, signalCode: exit.signal, stderr, stopped };
}
