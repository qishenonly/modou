/**
 * 钩子执行日志（T-141，design 002 十一「结构化日志（JSONL）」）。
 *
 * 记录「钩子跑了什么、结果如何、是否降级」——它是排查「为什么这个工具调用被
 * 拦下 / 放行」的依据（G-0.14.0 验收门「钩子执行有可查日志」）。与
 * logging/structured.ts 的 StructuredLogger 同款旁路语义：JSONL 追加写、内部
 * 串行写队列、写失败经 onError 上报不打断任务。
 *
 * 落盘位置：`~/.modou/logs/<project-hash>/hooks-<日期>.jsonl`（与结构化日志
 * 同目录分文件，避免把钩子条目混进 request / tool_call / permission 三类）。
 */

import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HookPoint } from './types';
import { projectHash } from '../session/log';

// ---------------------------------------------------------------------------
// 条目类型
// ---------------------------------------------------------------------------

/** 一次钩子执行记录（JSONL 一行）。 */
export interface HookLogEntry {
  readonly type: 'hook';
  /** 注入：写入时由 HookExecutionLog 打上 now()，调用方不必给。 */
  readonly ts?: number;
  readonly point: HookPoint;
  /** 钩子注册 ID（总线注册时生成；进程钩子由包装器注入）。 */
  readonly hookId: string;
  /** 执行的命令（可诊断：`<command> <args…>`）。 */
  readonly command: string;
  /** 工具名（工具点才有；非工具点省略）。 */
  readonly toolName?: string;
  /** 执行耗时（毫秒）。 */
  readonly durationMs: number;
  /** 最终裁决：allow / deny / block / proceed / continue。 */
  readonly decision: string;
  /** 是否降级（超时 / 崩溃 / 非法输出按 failBehavior 兜底）。 */
  readonly degraded: boolean;
  /** 裁决理由（deny / block 时必有；降级时说明降级原因）。 */
  readonly reason?: string;
  /** 进程退出码（进程被杀 / spawn 失败时为 null）。 */
  readonly exitCode?: number | null;
  /** 进程 stderr 摘要 / 异常信息（非零退出或崩溃时）。 */
  readonly error?: string;
}

/** HookExecutionLog 构造选项。 */
export interface HookExecutionLogOptions {
  /** 日志目录（缺省 `~/.modou/logs/<project-hash>`，由 homeDir + cwd 推导）。 */
  readonly dir?: string;
  /** 文件名（缺省 `hooks-<日期>.jsonl`，按天轮转）。 */
  readonly filename?: string;
  /** 写失败上报（缺省 stderr；不静默也不抛出）。 */
  readonly onError?: (error: unknown) => void;
  /** 时钟注入口（测试用；缺省 Date.now）。 */
  readonly now?: () => number;
}

/** 默认日志目录：`~/.modou/logs/<project-hash>`（design 002 十二用户侧布局）。 */
export function defaultHookLogDir(
  options: { readonly homeDir?: string; readonly cwd?: string } = {},
): string {
  const home = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  return join(home, '.modou', 'logs', projectHash(cwd));
}

/** 按天轮转的默认文件名：`hooks-YYYY-MM-DD.jsonl`。 */
export function defaultHookLogFilename(now: number = Date.now()): string {
  const date = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
  return `hooks-${ymd}.jsonl`;
}

/**
 * 钩子执行日志：JSONL 追加写。内部串行写队列保证行序与调用顺序一致；
 * 写失败经 onError 上报（缺省 stderr），**不抛出**——日志是旁路记录，不得
 * 因日志写失败打断钩子执行 / agent 循环。
 */
export class HookExecutionLog {
  private readonly file: string;
  private readonly onError: (error: unknown) => void;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: HookExecutionLogOptions = {}) {
    const dir = options.dir ?? defaultHookLogDir();
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, options.filename ?? defaultHookLogFilename());
    this.onError =
      options.onError ??
      ((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[modou] 钩子执行日志写失败：${message}`);
      });
    this.now = options.now ?? (() => Date.now());
  }

  /** 当前日志文件路径（测试 / 诊断用）。 */
  get path(): string {
    return this.file;
  }

  /**
   * 追加一条钩子执行记录。调用即排队，返回的 promise 在**该条落盘后** resolve
   * （测试可 await 后读文件断言）。写失败走 onError，不抛出。close 后丢弃新条目。
   */
  append(entry: Omit<HookLogEntry, 'ts'>): Promise<void> {
    const line = `${JSON.stringify({ ...entry, ts: this.now() })}\n`;
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      try {
        await appendFile(this.file, line, 'utf8');
      } catch (error) {
        this.onError(error);
      }
    });
    return this.queue;
  }

  /** 等待已排队条目全部落盘（测试 / 进程收尾用；幂等）。 */
  async flush(): Promise<void> {
    await this.queue;
  }

  /** 关闭：丢弃后续条目并等待已排队的落盘。 */
  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}
