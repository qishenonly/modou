/**
 * MCP（Model Context Protocol）客户端域类型（0.16.0，T-160~T-163）。
 *
 * 定位（docs/plan/phase-3-extensions.md §0.16.0）：一次实现，接管整个 MCP 生态。
 * MCP 工具与内置工具完全同管线（design 002 5.1 ①–⑧：MCP 只是往 Tools 注册表
 * 批量注册的另一批条目——权限与钩子天然覆盖，结构上不存在「MCP 绕过审批」）。
 *
 * 依赖取舍（ADR 0015）：**自写最小协议，不依赖 @modelcontextprotocol/sdk**。
 * - 需要的子集（stdio / streamable HTTP 传输 + initialize / tools/list / tools/call）
 *   在 JSON-RPC 2.0 上很薄且稳定；官方 SDK 为完整规范（roots / sampling / progress /
 *   完整生命周期）带来数百 KB 依赖，并引入 zod v3（本项目 zod v4 的 dual-install
 *   风险，见 ADR 0015「依赖取舍」）——与「内核小而稳」的架构目标相悖；
 * - 代价是协议边界细节（SSE 帧 / session 头 / 版本协商回落）自持并自测，本模块
 *   用自建最小 server 的契约测试覆盖（连接真实验证留 TUI 冒烟）。
 *
 * 目录边界：本模块只依赖 node 内建（child_process / http / fetch）与 zod（T-162
 * 工具注入的 schema 转换），不依赖 runtime / provider；tools/types 的方向由
 * mcp/inject.ts 单向消费（MCP → 内部 Tool，loop 视角无差别）。
 */

/** 客户端声明的 MCP 协议版本（最新；服务器可回落旧版，见 client.ts 协商）。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * MCP 工具命名空间前缀（T-162）：注册名 `mcp_<server>_<tool>`，避免与内置工具
 * 及跨 server 冲突。context/project.ts 的 MCP 工具定义单列（T-163 /context 分项）
 * 按此前缀在注册表内切分——构造处保证前缀，切分处只读约定，两侧互为注释。
 */
export const MCP_TOOL_PREFIX = 'mcp_';

/** 判断一个注册工具名是否 MCP 工具（命名空间前缀约定，见 MCP_TOOL_PREFIX）。 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0（MCP 的传输层协议）
// ---------------------------------------------------------------------------

/** 客户端 → 服务器的请求（期待响应）。 */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

/** 单向通知（不期待响应）。 */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

/** 成功响应。 */
export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result: unknown;
}

/** 错误响应（002 5.3「错误即数据」在协议层：错误作为返回值，不抛传输级异常）。 */
export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

/** 响应（成功或错误）。 */
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse;

/** 一条完整的 JSON-RPC 消息（传输层收发的单位）。 */
export type JsonRpcMessage =
  JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** JSON-RPC 2.0 标准错误码。 */
export const JSONRPC_CODE = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * MCP 协议错误（JSON-RPC error 响应 / 传输层失败归一后的可诊断错误）。
 * 由 protocol.ts 归一、client.ts 抛给调用方（工具执行侧捕获并转 ToolOutcome）。
 */
export class McpError extends Error {
  /** JSON-RPC 错误码（传输层失败用自定义码，见 client.ts）。 */
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

// ---------------------------------------------------------------------------
// 传输层抽象（stdio / streamable HTTP 各自实现）
// ---------------------------------------------------------------------------

/**
 * 传输层契约：向 McpClient 提供「发请求等响应 / 发通知 / 收服务器通知」。
 * 请求-响应关联（id）在传输层内完成——stdio 经子进程 stdout 关联，HTTP 经
 * POST 响应体关联；McpClient 不感知传输差异。
 */
export interface McpTransport {
  /** 建立连接（stdio：启动子进程并等待就绪；HTTP：无需预热）。失败抛 McpError。 */
  start(): Promise<void>;
  /**
   * 发送请求并等待对应 id 的响应（JSON-RPC 响应关联）。
   * - 服务器回 JSON-RPC error → resolve JsonRpcErrorResponse（协议层再归一）；
   * - 超时 / 连接断开 / abort → reject McpError（调用方按错误即数据处置）。
   */
  request(
    message: JsonRpcRequest,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<JsonRpcResponse>;
  /** 发送通知（不期待响应；HTTP 下服务器返回 202 即完成）。 */
  notify(message: JsonRpcNotification): Promise<void>;
  /** 注册服务器主动通知监听（progress / log 等；缺省忽略）。 */
  onNotification?(listener: (notification: JsonRpcNotification) => void): void;
  /** 注册连接关闭监听（子进程退出 / HTTP 流断开）——崩溃检测与重连的入口。 */
  onClose(listener: () => void): void;
  /** 关闭连接（杀子进程 / 断开 HTTP）。幂等。 */
  close(): void;
}

// ---------------------------------------------------------------------------
// MCP 高层域类型（tools/list 与 tools/call 的负载）
// ---------------------------------------------------------------------------

/** tools/list 返回的单个工具描述（inputSchema 是 JSON Schema 对象）。 */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/** 服务器身份（initialize 握手返回）。 */
export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

/** tools/call 返回的单个内容项（text / image / audio / resource）。 */
export type McpContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly mimeType?: string;
      readonly data: string;
    }
  | {
      readonly type: 'audio';
      readonly mimeType?: string;
      readonly data: string;
    }
  | {
      readonly type: 'resource';
      readonly uri?: string;
      readonly mimeType?: string;
      readonly text?: string;
      readonly blob?: string;
    };

/** tools/call 的执行结果（MCP 规范：isError 时内容为错误说明）。 */
export interface McpCallResult {
  readonly content: readonly McpContentPart[];
  readonly isError: boolean;
  readonly structuredContent?: unknown;
}

/**
 * 把 tools/call 的内容数组渲染为回喂模型的纯文本（002 5.3 错误即数据：
 * 文本部分原样；图片 / 资源以占位 + 元信息声明，绝不 base64 灌进上下文）。
 * 由 inject.ts 的执行侧调用；服务器返回空内容时给明确占位（不静默）。
 */
export function renderMcpContent(content: readonly McpContentPart[]): string {
  if (content.length === 0) return '（服务器返回空内容）';
  const parts: string[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        parts.push(part.text);
        break;
      case 'image':
        parts.push(
          `[图片 ${part.mimeType ?? '未知类型'}，base64 数据已省略——模型不可见]`,
        );
        break;
      case 'audio':
        parts.push(
          `[音频 ${part.mimeType ?? '未知类型'}，base64 数据已省略——模型不可见]`,
        );
        break;
      case 'resource': {
        const meta = [
          part.uri ?? '',
          part.mimeType ?? '',
          part.blob !== undefined ? 'blob' : '',
        ]
          .filter((item) => item.length > 0)
          .join(' · ');
        parts.push(
          part.text !== undefined
            ? `[资源 ${meta}] ${part.text}`
            : `[资源 ${meta}]（二进制内容，已省略）`,
        );
        break;
      }
      default:
        parts.push('[未知内容类型]');
        break;
    }
  }
  return parts.join('\n');
}
