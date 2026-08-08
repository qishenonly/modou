/**
 * MCP 客户端（T-160）：协议握手 / 能力协商 / tools/list / tools/call。
 *
 * 状态机（MCP 规范 §生命周期）：
 *   新建 → connect() → connected ──close()──> closed
 *                        │   （连接中途断开 → 抛 McpError，调用方 = manager
 *                        │    负责按 transport.onClose 判定崩溃并重连）
 *   connect() 内：initialize（版本协商 + 能力 + serverInfo）→ 发 initialized
 *   通知 → 标记 connected。版本协商：客户端声明 MCP_PROTOCOL_VERSION（最新），
 *   服务器回落旧版时以服务器的 protocolVersion 为准（客户端按需降级行为，
 *   本版只做记录——核心子集在 2024-11-05 与 2025-06-18 之间无差异）。
 *
 * 错误处理（002 5.3「错误即数据」）：
 * - JSON-RPC error 响应归一为 McpError（code/message/data），调用方（工具执行
 *   侧）捕获后转 ToolOutcome{ok:false} 回喂模型自纠；
 * - 传输层失败（子进程崩溃 / 超时 / abort）同样归一为 McpError，可诊断；
 * - connect() 失败不视为异常中断——调用方拿到错误可展示（/mcp 状态）、可重试。
 *
 * 目录边界：只依赖 transport 与 types；不感知工具注入（inject.ts 单向消费）。
 */

import { McpError } from './types';
import type {
  McpCallResult,
  McpServerInfo,
  McpToolDescriptor,
  McpTransport,
} from './types';
import { MCP_PROTOCOL_VERSION } from './types';

/** 连接状态（manager / TUI /mcp 展示用）。 */
export type McpClientState = 'new' | 'connecting' | 'connected' | 'closed';

/** McpClient 构造选项。 */
export interface McpClientOptions {
  /** 客户端身份（initialize 的 clientInfo；缺省 modou + 版本）。 */
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** initialize 握手超时（毫秒，缺省 10s）。 */
  readonly connectTimeoutMs?: number;
  /** tools/call 请求超时（毫秒，缺省 120s——远程工具可能长跑）。 */
  readonly callTimeoutMs?: number;
}

/** 握手产物：服务器身份 + 能力 + 协商后的协议版本。 */
export interface McpConnectionInfo {
  readonly serverInfo: McpServerInfo;
  readonly protocolVersion: string;
  /** 服务器声明的能力（tools.listChanged / logging / roots 等；客户端不强制）。 */
  readonly capabilities: Record<string, unknown>;
}

/**
 * MCP 客户端：一个 server 连接的高层操作面。传输由调用方注入
 * （stdio / HTTP 各自实现 McpTransport），本类只关心协议语义。
 */
export class McpClient {
  private state: McpClientState = 'new';
  private info: McpConnectionInfo | null = null;
  private seq = 1;
  private readonly options: Required<
    Pick<
      McpClientOptions,
      'clientName' | 'clientVersion' | 'connectTimeoutMs' | 'callTimeoutMs'
    >
  >;

  constructor(
    readonly serverName: string,
    private readonly transport: McpTransport,
    options: McpClientOptions = {},
  ) {
    this.options = {
      clientName: options.clientName ?? 'modou',
      clientVersion: options.clientVersion ?? '0.16.0',
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      callTimeoutMs: options.callTimeoutMs ?? 120_000,
    };
    // 传输意外关闭（子进程崩溃 / HTTP 断开）→ 客户端回落未连接态：
    // 在途请求已由传输层 failAll 拒绝，此处只改状态（manager 据此判定重连）。
    // 主动 close() 时状态已置 closed，本回调不改（见 close()）。
    this.transport.onClose(() => {
      if (this.state === 'connected') this.state = 'new';
    });
  }

  get connectionState(): McpClientState {
    return this.state;
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  /** 握手产物（connected 之后可用；未连接为 null）。 */
  get connectionInfo(): McpConnectionInfo | null {
    return this.info;
  }

  /**
   * 建立连接：initialize（版本协商 / 能力 / serverInfo）→ initialized 通知。
   * 幂等：已 connected 直接返回；连接失败不改变对象可用性（可重试 connect）。
   */
  async connect(): Promise<McpConnectionInfo> {
    if (this.state === 'connected' && this.info !== null) return this.info;
    if (this.state === 'closed') {
      throw new McpError(
        -32001,
        `MCP 客户端 ${this.serverName} 已关闭，不能重连（请重建实例）`,
      );
    }
    this.state = 'connecting';
    try {
      await this.transport.start();
      const result = await this.sendRequest(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: this.options.clientName,
            version: this.options.clientVersion,
          },
        },
        { timeoutMs: this.options.connectTimeoutMs },
      );
      const parsed = parseInitializeResult(result, this.serverName);
      this.info = {
        serverInfo: parsed.serverInfo,
        protocolVersion: parsed.protocolVersion,
        capabilities: parsed.capabilities,
      };
      // initialized 通知（不期待响应；服务器据此开始推送）
      await this.transport.notify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      this.state = 'connected';
      return this.info;
    } catch (caught) {
      this.state = 'new';
      // 连接失败：清理传输，防止半开连接泄漏
      try {
        this.transport.close();
      } catch {
        // 清理失败忽略
      }
      throw normalizeConnectError(caught, this.serverName);
    }
  }

  /** tools/list：取服务器暴露的全部工具描述。 */
  async listTools(): Promise<readonly McpToolDescriptor[]> {
    this.assertConnected('tools/list');
    const result = await this.sendRequest('tools/list', {});
    if (!isPlainObject(result)) {
      throw new McpError(
        -32602,
        `tools/list 返回非法结果（期望对象）——${this.serverName}`,
      );
    }
    const tools = (result as Record<string, unknown>).tools;
    if (!Array.isArray(tools)) {
      throw new McpError(
        -32602,
        `tools/list 返回非法结果（期望 tools 数组）——${this.serverName}`,
      );
    }
    const descriptors: McpToolDescriptor[] = [];
    for (const item of tools) {
      if (!isPlainObject(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.name !== 'string' || record.name.length === 0) continue;
      descriptors.push({
        name: record.name,
        ...(typeof record.description === 'string'
          ? { description: record.description }
          : {}),
        ...(record.inputSchema !== undefined
          ? { inputSchema: record.inputSchema }
          : {}),
      });
    }
    return descriptors;
  }

  /** tools/call：调用服务器上的一个工具。 */
  async callTool(
    toolName: string,
    args: unknown,
    options?: { readonly signal?: AbortSignal },
  ): Promise<McpCallResult> {
    this.assertConnected('tools/call');
    const result = await this.sendRequest(
      'tools/call',
      {
        name: toolName,
        ...(isPlainObject(args) ? { arguments: args } : {}),
      },
      {
        timeoutMs: this.options.callTimeoutMs,
        signal: options?.signal,
      },
    );
    if (!isPlainObject(result)) {
      throw new McpError(
        -32602,
        `tools/call 返回非法结果（期望对象）——${this.serverName} 的 ${toolName}`,
      );
    }
    const record = result as Record<string, unknown>;
    return {
      content: Array.isArray(record.content)
        ? (record.content as McpCallResult['content'])
        : [],
      isError: record.isError === true,
      ...(record.structuredContent !== undefined
        ? { structuredContent: record.structuredContent }
        : {}),
    };
  }

  /** ping：活性探活（manager 崩溃检测 / 手动重连前可用）。 */
  async ping(): Promise<void> {
    this.assertConnected('ping');
    await this.sendRequest('ping', {});
  }

  /** 关闭连接（杀子进程 / 断开 HTTP）。幂等。 */
  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.transport.close();
  }

  /** 注册连接关闭监听（转发 transport.onClose——manager 据此判定崩溃重连）。 */
  onClose(listener: () => void): void {
    this.transport.onClose(listener);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private assertConnected(operation: string): void {
    if (this.state !== 'connected') {
      throw new McpError(
        -32001,
        `MCP 客户端 ${this.serverName} 未连接，无法 ${operation}（连接状态：${this.state}）`,
      );
    }
  }

  private async sendRequest(
    method: string,
    params: unknown,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<unknown> {
    const id = this.seq;
    this.seq += 1;
    const response = await this.transport.request(
      {
        jsonrpc: '2.0',
        id,
        method,
        params,
      },
      {
        timeoutMs: options?.timeoutMs ?? 30_000,
        signal: options?.signal,
      },
    );
    if ('error' in response) {
      throw new McpError(
        response.error.code,
        response.error.message,
        response.error.data,
      );
    }
    return response.result;
  }
}

// ---------------------------------------------------------------------------
// 负载解析（防御性：服务器返回不符合规范时给可诊断错误，不抛非 McpError）
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 归一 initialize 结果负载（protocolVersion / capabilities / serverInfo）。 */
function parseInitializeResult(
  result: unknown,
  serverName: string,
): {
  readonly protocolVersion: string;
  readonly capabilities: Record<string, unknown>;
  readonly serverInfo: McpServerInfo;
} {
  if (!isPlainObject(result)) {
    throw new McpError(
      -32602,
      `initialize 返回非法结果（期望对象）——${serverName}`,
    );
  }
  const record = result as Record<string, unknown>;
  const protocolVersion =
    typeof record.protocolVersion === 'string' &&
    record.protocolVersion.length > 0
      ? record.protocolVersion
      : MCP_PROTOCOL_VERSION;
  const capabilities = isPlainObject(record.capabilities)
    ? (record.capabilities as Record<string, unknown>)
    : {};
  let serverInfo: McpServerInfo;
  if (
    isPlainObject(record.serverInfo) &&
    typeof record.serverInfo.name === 'string'
  ) {
    serverInfo = {
      name: record.serverInfo.name,
      version:
        typeof record.serverInfo.version === 'string'
          ? record.serverInfo.version
          : '',
    };
  } else {
    serverInfo = { name: serverName, version: '' };
  }
  return { protocolVersion, capabilities, serverInfo };
}

/** 连接失败归一：非 McpError 一律转 McpError（调用方按错误即数据处置）。 */
function normalizeConnectError(caught: unknown, serverName: string): McpError {
  if (caught instanceof McpError) return caught;
  if (caught instanceof Error) {
    return new McpError(
      -32001,
      `连接 MCP 服务器 ${serverName} 失败：${caught.message}`,
    );
  }
  return new McpError(
    -32001,
    `连接 MCP 服务器 ${serverName} 失败：${String(caught)}`,
  );
}
