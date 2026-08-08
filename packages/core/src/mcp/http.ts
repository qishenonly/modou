/**
 * MCP Streamable HTTP 传输（T-161，2025-06-18 规范 §传输 > Streamable HTTP）。
 *
 * 客户端语义（本实现）：
 * - **每条请求一条 POST**：把 JSON-RPC 请求 POST 到端点，`Accept:
 *   application/json, text/event-stream`；响应体是 `application/json`（单条
 *   JSON-RPC 响应）或 `text/event-stream`（SSE 帧流，从帧里按 id 取出本请求
 *   的响应）——两者都解析，取与请求 id 匹配的那条消息；
 * - **通知也是 POST**：不期待响应体（服务器回 202 即完成）；
 * - **会话**：响应头 `Mcp-Session-Id` 存在时保存，后续请求回传（无会话 =
 *   无状态服务，本实现不强求）；建立会话后客户端**可选**开启一条 GET SSE
 *   长流接收服务器主动通知（progress / log 等）——关闭即停止，不影响
 *   POST 请求路径；
 * - **超时 / abort**：每个请求独立的 AbortController（超时 + 外部信号合并），
 *   超时或中止即拒绝并清理。
 *
 * 与旧式 HTTP+SSE（2024-11-05 的 /sse 建立 + /messages POST）的区别：
 * 本实现只支持 Streamable HTTP 端点（现代实现），旧式端点不支持（ADR 0015
 * 「传输子集」记录该边界；真实生态以 Streamable HTTP 为主，Claude Code /
 * 主流 SDK 均已切换）。
 *
 * 目录边界：只依赖 node 内建（fetch / AbortController 为运行时内置）与本包
 * types；不感知 McpClient 之外的模块。
 */

import { McpError } from './types';
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
} from './types';

/** HTTP 传输构造参数（settings.json mcp.servers.<name> 的 http 形态）。 */
export interface HttpTransportParams {
  /** Streamable HTTP 端点（http/https URL）。 */
  readonly url: string;
  /** 追加的请求头（Authorization / API Key 等；缺省不带）。 */
  readonly headers?: Readonly<Record<string, string>>;
  /** 请求超时（毫秒，缺省 30s——与 stdio 传输同口径）。 */
  readonly requestTimeoutMs?: number;
  /** 是否开启 GET SSE 长流接收服务器主动通知（缺省 true——建立会话后开启）。 */
  readonly openServerStream?: boolean;
}

/** SSE 帧解析器（MCP 的 Streamable HTTP 用 text/event-stream 承载消息）。 */
export class SseParser {
  private buffer = '';
  private eventName = 'message';
  private dataLines: string[] = [];

  /** 喂入一段文本，返回完整事件（按空行分隔；数据跨行以换行拼接）。 */
  push(chunk: string, onEvent: (event: string, data: string) => void): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) {
        // 空行 = 事件结束
        if (this.dataLines.length > 0 || this.eventName !== 'message') {
          onEvent(this.eventName, this.dataLines.join('\n'));
        }
        this.eventName = 'message';
        this.dataLines = [];
        continue;
      }
      if (line.startsWith(':')) continue; // 注释行
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') {
        this.eventName = value;
      } else if (field === 'data') {
        this.dataLines.push(value);
      }
      // 其余字段（id / retry 等）本实现不消费
    }
  }
}

/**
 * MCP Streamable HTTP 传输：POST 请求-响应关联（按 id 从响应体/SSE 帧取）、
 * 通知、会话头、服务器主动通知长流。
 */
export class HttpTransport implements McpTransport {
  private sessionId: string | null = null;
  private closed = false;
  private closeListeners: Array<() => void> = [];
  private notificationListeners: Array<
    (notification: JsonRpcNotification) => void
  > = [];
  private serverStreamController: AbortController | null = null;
  private readonly options: Required<
    Pick<HttpTransportParams, 'requestTimeoutMs' | 'openServerStream'>
  >;

  constructor(private readonly params: HttpTransportParams) {
    this.options = {
      requestTimeoutMs: params.requestTimeoutMs ?? 30_000,
      openServerStream: params.openServerStream ?? true,
    };
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): void {
    this.notificationListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /** HTTP 无需预热（会话在第一次 initialize POST 时建立；崩溃后重启复位 closed）。 */
  async start(): Promise<void> {
    // 崩溃后重启：closed 由 close() 置位，这里复位（主动 close() 的路径不可达——
    // 客户端状态已 closed，connect() 拒绝进入）。旧会话头可能已失效，服务器会
    // 在 initialize 响应里回新的（或拒绝，connect 失败 → manager 按退避重试）。
    this.closed = false;
  }

  /** POST 一条请求并等待同 id 响应（JSON 或 SSE 帧流两种响应体都支持）。 */
  async request(
    message: JsonRpcRequest,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<JsonRpcResponse> {
    const response = await this.post(
      message,
      options?.timeoutMs ?? this.options.requestTimeoutMs,
      options?.signal,
    );
    const parsed = await parseResponseBody(response);
    // 取与请求 id 匹配的响应（SSE 帧流可能混入通知 / 其他响应）
    const match = parsed.find(
      (item): item is JsonRpcResponse => 'id' in item && item.id === message.id,
    );
    if (match !== undefined) {
      if (match.jsonrpc !== '2.0' || !isResponse(match)) {
        throw new McpError(
          -32600,
          `MCP HTTP 响应非法（期望与请求 ${message.id} 同 id 的 JSON-RPC 响应）`,
        );
      }
      return match;
    }
    throw new McpError(
      -32003,
      `MCP HTTP 请求超时或未收到响应（method ${message.method}，id ${message.id}）`,
    );
  }

  /** POST 一条通知（不期待响应体；HTTP 202 即完成）。 */
  async notify(message: JsonRpcNotification): Promise<void> {
    await this.post(message, this.options.requestTimeoutMs, undefined);
  }

  /** 关闭连接：中止 GET 长流、标记关闭。幂等。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.serverStreamController?.abort();
    this.serverStreamController = null;
    // 关闭监听不清理：重连回调需跨次保留（崩溃后重连再崩溃）
    this.closeListeners.forEach((listener) => listener());
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async post(
    message: JsonRpcRequest | JsonRpcNotification,
    timeoutMs: number,
    externalSignal: AbortSignal | undefined,
  ): Promise<Response> {
    if (this.closed) {
      throw new McpError(-32001, 'MCP HTTP 传输已关闭，无法发送消息');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new McpError(
          -32003,
          `MCP HTTP 请求超时（${timeoutMs}ms）：method ${message.method}`,
        ),
      );
    }, timeoutMs);
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        controller.abort(
          new McpError(
            -32002,
            'MCP HTTP 请求已取消（收到外部中止信号）',
            externalSignal.reason,
          ),
        );
      } else {
        externalSignal.addEventListener(
          'abort',
          () =>
            controller.abort(
              new McpError(
                -32002,
                'MCP HTTP 请求已取消（收到外部中止信号）',
                externalSignal.reason,
              ),
            ),
          { once: true },
        );
      }
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.params.headers ?? {}),
        ...(this.sessionId !== null
          ? { 'Mcp-Session-Id': this.sessionId }
          : {}),
      };
      const response = await fetch(this.params.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      // 会话头保存（后续请求回传；也触发 GET 长流的开启）
      const session = response.headers.get('mcp-session-id');
      if (session !== null && session.length > 0) {
        this.sessionId = session;
        this.openServerStreamIfNeeded();
      }
      if (!response.ok) {
        throw new McpError(
          -32001,
          `MCP HTTP 请求失败（HTTP ${response.status} ${response.statusText}，method ${message.method}）`,
        );
      }
      return response;
    } catch (caught) {
      if (caught instanceof McpError) throw caught;
      if (isAbortError(caught)) {
        // fetch 被中止：区分超时（timer 触发）与外部信号
        if (externalSignal?.aborted === true) {
          throw new McpError(
            -32002,
            'MCP HTTP 请求已取消（收到外部中止信号）',
            externalSignal.reason,
          );
        }
        throw new McpError(
          -32003,
          `MCP HTTP 请求超时（${timeoutMs}ms）：method ${message.method}`,
        );
      }
      throw new McpError(
        -32001,
        `MCP HTTP 请求失败：${formatCause(caught)}（method ${message.method}）`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 会话建立后开启 GET SSE 长流接收服务器主动通知（幂等：只开一条）。 */
  private openServerStreamIfNeeded(): void {
    if (!this.options.openServerStream) return;
    if (this.serverStreamController !== null) return; // 已有一条
    const controller = new AbortController();
    this.serverStreamController = controller;
    void this.runServerStream(controller.signal);
  }

  private async runServerStream(signal: AbortSignal): Promise<void> {
    try {
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        ...(this.params.headers ?? {}),
        ...(this.sessionId !== null
          ? { 'Mcp-Session-Id': this.sessionId }
          : {}),
      };
      const response = await fetch(this.params.url, {
        method: 'GET',
        headers,
        signal,
      });
      if (!response.ok || response.body === null) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }), (event, data) => {
          if (event !== 'message' && event !== '') return;
          this.handleServerMessage(data);
        });
      }
    } catch {
      // 长流断开（服务器关闭 / abort）：静默停止——POST 请求路径不依赖它
    }
  }

  private handleServerMessage(data: string): void {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const record = message as Record<string, unknown>;
    if (record.jsonrpc !== '2.0' || typeof record.method !== 'string') return;
    if (typeof record.id === 'number') return; // 服务器发来的请求：本版不消费
    this.notificationListeners.forEach((listener) =>
      listener(record as unknown as JsonRpcNotification),
    );
  }
}

// ---------------------------------------------------------------------------
// 响应体解析（JSON 或 SSE 帧流 → JSON-RPC 消息数组）
// ---------------------------------------------------------------------------

/** 读取响应体：application/json 单条；text/event-stream 多条帧。 */
async function parseResponseBody(
  response: Response,
): Promise<readonly JsonRpcMessage[]> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    const messages: JsonRpcMessage[] = [];
    const parser = new SseParser();
    parser.push(text, (event, data) => {
      if (event !== 'message' && event !== '') return;
      const parsed = tryParseJson(data);
      if (parsed !== null) messages.push(parsed);
    });
    return messages;
  }
  const text = await response.text();
  if (text.length === 0) return []; // 202 空响应体（通知）
  const parsed = tryParseJson(text);
  return parsed !== null ? [parsed] : [];
}

function tryParseJson(text: string): JsonRpcMessage | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    if ((value as Record<string, unknown>).jsonrpc !== '2.0') return null;
    return value as JsonRpcMessage;
  } catch {
    return null;
  }
}

/** 一条消息是否 JSON-RPC 响应（含 id、无 method）。 */
function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return 'id' in message && !('method' in message);
}

function isAbortError(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    ((cause as { name?: unknown }).name === 'AbortError' ||
      (cause as { name?: unknown }).name === 'TimeoutError' ||
      (cause as { name?: unknown }).name === 'DOMException')
  );
}

function formatCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
