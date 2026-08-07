/**
 * CLI 参数解析（0.1.0 最小实现：够 `-p` 用即可，完整 arg 框架留给后续）。
 */

/** 解析结果。 */
export interface CliArgs {
  /** `-p` / `--prompt` 提交的提示词（未提供为 undefined）。 */
  readonly prompt?: string;
  /** 是否请求帮助。 */
  readonly help: boolean;
  /**
   * `--auto-approve`：跳过写入/执行审批（自用/评测用，headless 策略放行；
   * 危险命令仍强制逐次确认）。缺省 false = 默认拒绝。
   */
  readonly autoApprove: boolean;
}

/** 参数解析错误（缺值 / 未知参数 / 意外位置参数）。 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * 解析命令行参数，支持：
 * - `-p <文本>` / `--prompt <文本>` / `--prompt=<文本>`
 * - `--auto-approve`（布尔标志：跳过写入/执行审批）
 * - `-h` / `--help`
 *
 * 其他任何参数（含裸位置参数）都抛 `UsageError`，由 main 打印用法后退出。
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  let prompt: string | undefined;
  let help = false;
  let autoApprove = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }

    if (arg === '--auto-approve') {
      autoApprove = true;
      continue;
    }

    if (arg === '-p' || arg === '--prompt') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new UsageError(`${arg} 需要一个参数值，如 ${arg} "你好"`);
      }
      prompt = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--prompt=')) {
      const value = arg.slice('--prompt='.length);
      if (value === '') {
        throw new UsageError('--prompt= 需要一个非空参数值');
      }
      prompt = value;
      continue;
    }

    if (arg.startsWith('-') && arg !== '-') {
      throw new UsageError(`未知参数：${arg}`);
    }

    throw new UsageError(`意外的位置参数：${arg}（请用 -p "..." 传入提示词）`);
  }

  return { prompt, help, autoApprove };
}
