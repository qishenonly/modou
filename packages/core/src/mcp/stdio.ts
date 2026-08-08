/**
 * MCP stdio 传输（T-160）：子进程 + stdin/stdout 换行分隔 JSON-RPC。
 *
 * 规范对齐（2025-06-18 规范 §传输 > stdio）：
 * - 客户端把 JSON-RPC 消息按 UTF-8 序列化后**每条一行**写入子进程 stdin；
 * - 服务器从 stdout 按行读取，同样一条一行写回；
 * - stderr 不承载协议消息——转发给调用方（manager 保留环缓冲供 /mcp 状态展示），
 *   子进程过早退出时把它并入连接失败的错误文本（可诊断）。
 *
 * 生命周期与崩溃：
 * - start()：spawn 子进程（命令拆分执行，不支持 shell 语法——与 hooks 执行器同
 *   约定，见 hooks/executor.ts）；stdout 逐行解析，行内合法 JSON 且含 jsonrpc 字段
 *   才上抛（半行 / 服务器打印的杂讯忽略，避免协议串线）；
 * - close()：kill 子进程（SIGTERM → 短暂宽限 → SIGKILL），幂等；
 * - 子进程自行退出（exit/error 事件）→ onClose 回调——McpManager 据此判定崩溃
 *   并调度重连（T-163）；stdin 写失败（EPIPE）视同关闭。
 *
 * 目录边界：只依赖 node:child_process / node:readline 与本包 types；不依赖
 * runtime / provider（002 2.2 Tools 模块的依赖约束）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  McpError,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpTransport,
} from './types';

/** 子进程的启动参数（settings.json mcp.servers.<name> 的 stdio 形态）。 */
export interface StdioServerParams {
  readonly command: string;
  readonly args?: readonly string[];
  /** 追加的环境变量（继承进程环境，此项覆盖）。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 子进程工作目录（缺省继承当前进程）。 */
  readonly cwd?: string;
}

/**
 * MCP stdio 传输：请求-响应关联在层内完成（pending map 按 id），
 * 服务器通知经 onNotification 转发（本模块只转发、不消费）。
 */
export class StdioTransport implements McpTransport {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<
    number,
    {
      resolve: (message: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      cleanup: () => void;
    }
  >();
  private nextId = 1;
  private closed = false;
  private closeListeners: Array<() => void> = [];
  private notificationListeners: Array<
    (notification: JsonRpcNotification) => void
  > = [];

  constructor(private readonly params: StdioServerParams) {}

  /** 服务器主动通知监听（progress 等；缺省忽略）。 */
  onNotification(listener: (notification: JsonRpcNotification) => void): void {
    this.notificationListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /** 启动子进程并接好 stdin/stdout/stderr 三路。等待 spawn 就绪（失败抛可诊断错误）。 */
  async start(): Promise<void> {
    if (this.child !== null) return; // 已启动，幂等
    const child = spawn(this.params.command, [...(this.params.args ?? [])], {
      env: {
        ...process.env,
        ...(this.params.env ?? {}),
      },
      ...(this.params.cwd !== undefined ? { cwd: this.params.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      // 'spawn' 事件 = 进程成功拉起；'error' = 拉起失败（ENOENT 等）——异步失败
      // 在此收敛为 start() 的拒绝（connect() 归一为 McpError，调用方可诊断）。
      child.once('spawn', () => resolve());
      child.once('error', (cause) => {
        reject(
          new McpError(
            -32001,
            `启动 MCP 子进程失败：${formatCause(cause)}（command: ${this.params.command}）`,
          ),
        );
      });
    });
    child.on('error', (cause) => {
      this.failAll(
        new McpError(
          -32001,
          `MCP 子进程错误：${formatCause(cause)}（command: ${this.params.command}）`,
        ),
      );
      this.handleClose();
    });
    child.on('exit', (code, signal) => {
      // 正常 close() 由 handleClose 收尾；意外退出也要 failAll（在途请求拒绝）
      this.failAll(
        new McpError(
          -32001,
          `MCP 子进程意外退出（exit=${String(code)} signal=${String(signal)}，command: ${this.params.command}）`,
        ),
      );
      this.handleClose();
    });

    // stdout：逐行解析 JSON-RPC（合法 JSON + jsonrpc 字段才上抛）
    const stdout = child.stdout;
    if (stdout !== null) {
      const reader = createInterface({ input: stdout });
      reader.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        let message: unknown;
        try {
          message = JSON.parse(trimmed);
        } catch {
          return; // 半行 / 非 JSON 杂讯：忽略（stdout 只承载协议消息）
        }
        if (!isJsonRpcMessage(message)) return;
        this.dispatch(message);
      });
    }

    // stderr：转发给调用方（manager 记日志 / 保留状态展示；此处不解析）
    const stderr = child.stderr;
    if (stderr !== null) {
      stderr.setEncoding('utf8');
      stderr.on('data', (chunk: string) => {
        this.stderrListeners.forEach((listener) => listener(String(chunk)));
      });
    }

    // stdin 写失败（EPIPE——子进程已死）视同关闭
    const stdin = child.stdin;
    if (stdin !== null) {
      stdin.on('error', () => {
        this.failAll(
          new McpError(
            -32001,
            `MCP 子进程 stdin 已断开（command: ${this.params.command}）`,
          ),
        );
        this.handleClose();
      });
    }
  }

  /** 发送请求并等待同 id 响应（pending 关联 + 超时 + abort 清理）。 */
  request(
    message: JsonRpcRequest,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      if (this.closed || this.child === null || this.child.stdin?.destroyed) {
        reject(
          new McpError(
            -32001,
            'MCP 传输已关闭，无法发送请求（连接可能已断开）',
          ),
        );
        return;
      }
      if (options?.signal?.aborted === true) {
        reject(
          new McpError(
            -32002,
            'MCP 请求已取消（收到外部中止信号）',
            options.signal.reason,
          ),
        );
        return;
      }

      const timeoutMs = options?.timeoutMs ?? 30_000;
      let settled = false;
      const cleanup = (): void => {
        this.pending.delete(message.id);
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new McpError(
            -32003,
            `MCP 请求超时（${timeoutMs}ms）：method ${message.method}`,
          ),
        );
      }, timeoutMs);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new McpError(
            -32002,
            'MCP 请求已取消（收到外部中止信号）',
            options?.signal?.reason,
          ),
        );
      };
      if (options?.signal !== undefined) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(message.id, {
        resolve: (response) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(response);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
        timer,
        cleanup,
      });
      try {
        this.writeMessage(message);
      } catch (cause) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new McpError(
            -32001,
            `MCP 请求发送失败：${formatCause(cause)}（method ${message.method}）`,
          ),
        );
      }
    });
  }

  /** 发送通知（stdin 写入一条 JSON-RPC notification，不期待响应）。 */
  async notify(message: JsonRpcNotification): Promise<void> {
    if (this.closed || this.child === null || this.child.stdin?.destroyed) {
      throw new McpError(-32001, 'MCP 传输已关闭，无法发送通知');
    }
    this.writeMessage(message);
  }

  /** 关闭连接：kill 子进程（SIGTERM → 宽限 → SIGKILL），幂等。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (child !== null) {
      this.failAll(new McpError(-32001, 'MCP 传输已关闭（调用方主动 close）'));
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {
          // 进程已死，忽略
        }
        const fallback = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL');
            }
          } catch {
            // 已退出，忽略
          }
        }, 1000);
        fallback.unref?.();
      }
    }
    this.handleClose();
  }

  // -------------------------------------------------------------------------
  // 内部：消息分发 / 关闭 / 工具函数
  // -------------------------------------------------------------------------

  private writeMessage(message: JsonRpcRequest | JsonRpcNotification): void {
    const child = this.child;
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      throw new McpError(-32001, 'MCP 子进程 stdin 不可写（连接已断开）');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private dispatch(message: JsonRpcMessage): void {
    // 响应：含 id 且无 method（请求虽然也含 id，但带 method——先窄化掉）
    if ('id' in message && !('method' in message)) {
      const response = message as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (pending !== undefined) {
        if ('error' in response) {
          pending.reject(
            new McpError(
              response.error.code,
              response.error.message,
              response.error.data,
            ),
          );
        } else {
          pending.resolve(response);
        }
      }
      // 未知 id 的响应：忽略（迟到的响应 / 已超时的请求）
      return;
    }
    // 服务器主动通知（无 id）
    if (!('id' in message)) {
      this.notificationListeners.forEach((listener) => listener(message));
    }
    // 服务器发出的请求（含 id + method，如 sampling/createMessage）：本版不消费
  }

  private failAll(error: Error): void {
    for (const pending of [...this.pending.values()]) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleClose(): void {
    // 子进程已死：清空引用——同实例后续 start() 可重新拉起（重建传输）
    this.child = null;
    this.closed = true;
    this.closeListeners.forEach((listener) => listener());
    this.closeListeners = [];
  }

  // stderr 转发监听（manager 记日志用；不承载协议消息）
  private stderrListeners: Array<(chunk: string) => void> = [];
  onStderr(listener: (chunk: string) => void): void {
    this.stderrListeners.push(listener);
  }
}

/** 是否为一条结构合法的 JSON-RPC 消息（jsonrpc 字段存在且为 '2.0'）。 */
export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === '2.0';
}

/** 归一子进程启动/错误原因为可读文本。 */
function formatCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
