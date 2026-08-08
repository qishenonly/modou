/**
 * MCP 服务器管理器（T-163）：server 启停管理 / 崩溃重连 / 状态报告。
 *
 * 职责（design 002 5.1：MCP 工具与内置工具完全同管线）：
 * - **装配**：按 settings.json 的 mcp.servers 配置连接全部 enabled server（stdio /
 *   Streamable HTTP 两种传输），握手后 tools/list → 过滤（工具级过滤白名单）→
 *   注入工具注册表（inject.ts，risk 按 server 配置覆盖，缺省 network）；
 * - **生命周期**：start() 连接、stop() 关闭；初始连接失败 → 状态 failed（不自动
 *   重试，用户可在 /mcp 看到错误）；已连接后崩溃 → 状态 disconnected + 指数退避
 *   自动重连（复用同一 McpClient——注入工具的执行闭包捕获它，重连后继续有效；
 *   server 新增的工具在重连时增量补注）；
 * - **崩溃隔离**：一个 server 崩溃只影响自身（重连），不拖垮其他 server 与主
 *   loop——在途工具调用由注入层归为 ToolOutcome{ok:false} 回喂模型（错误即数据）。
 *
 * 状态机（每 server）：
 *   start() ──connect 成功──> connected ──transport.onClose（崩溃）──> disconnected
 *     │                              ↑                                    │
 *     │                              └──────── 退避重连（复用同一 client）─┘
 *     └──connect 失败──> failed（记录错误；不自动重试，可 /mcp 查看）
 *
 * 目录边界：本模块只依赖 node 内建、本包 mcp 内部与 tools/registry、
 * config/settings 的类型；不依赖 runtime / provider。
 */

import type { ConfigMcp } from '../config/settings';
import type { ToolRegistry } from '../tools/registry';
import type { ToolRisk } from '../tools/types';
import { McpClient } from './client';
import { HttpTransport } from './http';
import { registerMcpTools } from './inject';
import { mcpToolName } from './inject';
import { StdioTransport } from './stdio';
import type { McpServerInfo, McpTransport } from './types';
import { McpError } from './types';

/** 归一化后的 MCP 服务器配置（settings.json mcp.servers.<name> + 缺省补齐）。 */
export interface McpServerConfig {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  /** stdio：可执行命令 + 参数 + 环境变量。 */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** http：Streamable HTTP 端点 + 附加请求头。 */
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  /** 工具风险归类（缺省 network；权限矩阵的裁决维度，见 permission/policy.ts）。 */
  readonly risk: ToolRisk;
  /** 工具级过滤白名单（缺省 undefined = 全部暴露）。 */
  readonly tools?: readonly string[];
  readonly connectTimeoutMs: number;
  readonly callTimeoutMs: number;
}

/** 服务器连接状态（/mcp 展示 + 重连判定）。 */
export type McpServerState =
  'disconnected' | 'connecting' | 'connected' | 'failed';

/** 一个 server 的状态快照（/mcp 报告数据源）。 */
export interface McpServerStatus {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly state: McpServerState;
  /** 握手产物（connected 后存在）。 */
  readonly serverInfo?: McpServerInfo;
  readonly protocolVersion?: string;
  /** 已注入注册表的工具数（本 server 贡献）。 */
  readonly toolCount: number;
  /** 最近一次失败 / 断开的可诊断信息（连接成功时清除）。 */
  readonly error?: string;
  readonly connectedAt?: number;
  readonly lastErrorAt?: number;
}

/** McpManager 构造选项。 */
export interface McpManagerOptions {
  readonly servers: readonly McpServerConfig[];
  /** 注入目标：MCP 工具批量注册进这个注册表（loop 视角与内置工具无差别）。 */
  readonly registry: ToolRegistry;
  /** 崩溃重连的初始退避（毫秒，缺省 1000）。 */
  readonly reconnectBaseMs?: number;
  /** 崩溃重连的退避上限（毫秒，缺省 30_000）。 */
  readonly reconnectMaxMs?: number;
  /** 状态变化回调（TUI 发 notice / 重建提示词用）。 */
  readonly onStatusChange?: (status: McpServerStatus) => void;
}

/** 一个 server 的内部运行条目。 */
interface ServerEntry {
  readonly config: McpServerConfig;
  client: McpClient | null;
  status: McpServerStatus;
  /** 是否曾成功连接（用于区分「初始失败不重试」与「崩溃后自动重连」）。 */
  hasConnected: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  stopped: boolean;
}

/** 把 settings.json 的 mcp 配置归一为管理器可用的 server 配置表（缺省补齐）。 */
export function normalizeMcpServers(
  config: ConfigMcp | undefined,
): McpServerConfig[] {
  if (config === undefined) return [];
  return Object.entries(config.servers).map(([name, server]) => {
    const stdio = server.command !== undefined;
    return {
      name,
      transport: stdio ? 'stdio' : 'http',
      ...(server.command !== undefined ? { command: server.command } : {}),
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
      ...(server.url !== undefined ? { url: server.url } : {}),
      enabled: server.enabled ?? true,
      risk: server.risk ?? 'network',
      ...(server.tools !== undefined ? { tools: server.tools } : {}),
      connectTimeoutMs: server.connectTimeoutMs ?? 10_000,
      callTimeoutMs: server.callTimeoutMs ?? 120_000,
    };
  });
}

/** 状态报告渲染用的时间格式（/mcp 展示：HH:MM:SS）。 */
export function formatMcpTime(ts: number | undefined): string {
  if (ts === undefined || ts <= 0) return '—';
  const date = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * MCP 服务器管理器：连接 / 注入 / 崩溃重连 / 状态。线程模型：start() 并行连接
 * 全部 enabled server（每个 server 独立失败处理，互不拖累）；stop() 幂等。
 */
export class McpManager {
  private readonly entries: ServerEntry[];
  private readonly registry: ToolRegistry;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly onStatusChange?: (status: McpServerStatus) => void;
  private started = false;

  constructor(options: McpManagerOptions) {
    this.registry = options.registry;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.onStatusChange = options.onStatusChange;
    this.entries = options.servers.map((config) => ({
      config,
      client: null,
      status: {
        name: config.name,
        transport: config.transport,
        state: 'disconnected',
        toolCount: 0,
      },
      hasConnected: false,
      reconnectTimer: null,
      reconnectAttempts: 0,
      stopped: false,
    }));
  }

  /** 全部 server 的状态快照（/mcp 报告；含未启用的 server）。 */
  status(): readonly McpServerStatus[] {
    return this.entries.map((entry) => ({ ...entry.status }));
  }

  /** 已注册到注册表的 MCP 工具总数（注入成功的 server 贡献合计）。 */
  get activeToolCount(): number {
    return this.entries.reduce((sum, entry) => sum + entry.status.toolCount, 0);
  }

  /** 已配置的 server 数（含未启用）。 */
  get serverCount(): number {
    return this.entries.length;
  }

  /**
   * 启动：并行连接全部 enabled server。每个 server 的连接失败独立处理
   * （状态 failed + 错误记录，不抛——不拖垮其余 server 与主 loop）。
   * 未配置 server 时为空操作。
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const enabled = this.entries.filter((entry) => entry.config.enabled);
    await Promise.all(enabled.map((entry) => this.connectServer(entry)));
  }

  /** 关闭全部连接（杀子进程 / 断开 HTTP）。幂等。 */
  async stop(): Promise<void> {
    for (const entry of this.entries) {
      entry.stopped = true;
      if (entry.reconnectTimer !== null) {
        clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = null;
      }
      if (entry.client !== null) {
        await entry.client.close();
      }
    }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 构造传输层（stdio 子进程 / streamable HTTP）。 */
  private buildTransport(config: McpServerConfig): McpTransport {
    if (config.transport === 'stdio') {
      return new StdioTransport({
        command: config.command ?? '',
        ...(config.args !== undefined ? { args: config.args } : {}),
        ...(config.env !== undefined ? { env: config.env } : {}),
      });
    }
    return new HttpTransport({
      url: config.url ?? '',
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      requestTimeoutMs: config.connectTimeoutMs,
    });
  }

  /** 更新状态并通知（onStatusChange 回调）。 */
  private updateStatus(
    entry: ServerEntry,
    patch: Partial<McpServerStatus>,
  ): void {
    entry.status = { ...entry.status, ...patch };
    this.onStatusChange?.({ ...entry.status });
  }

  /**
   * 连接（或重连）一个 server：传输 → 握手 → tools/list → 过滤 → 注入。
   * 崩溃重连复用同一 client（注入工具的执行闭包继续有效）；server 新增的工具
   * 在重连时增量补注。
   */
  private async connectServer(entry: ServerEntry): Promise<void> {
    if (entry.stopped) return;
    const { config } = entry;
    this.updateStatus(entry, { state: 'connecting' });
    try {
      // 复用既有 client（崩溃后 client 回落 new 态、传输可重启）；首次创建
      if (entry.client === null) {
        const transport = this.buildTransport(config);
        entry.client = new McpClient(config.name, transport, {
          connectTimeoutMs: config.connectTimeoutMs,
          callTimeoutMs: config.callTimeoutMs,
        });
        // 崩溃检测入口：传输意外关闭 → 状态 disconnected + 退避重连
        entry.client.onClose(() => {
          this.handleUnexpectedClose(entry);
        });
      }
      const client = entry.client;
      const info = await client.connect();
      const descriptors = (await client.listTools()).filter(
        (descriptor) =>
          config.tools === undefined || config.tools.includes(descriptor.name),
      );
      // 注入：首次全量；重连只补注新增工具（既有工具的执行闭包复用同一 client）
      const missing = descriptors.filter(
        (descriptor) =>
          !this.registry.has(mcpToolName(config.name, descriptor.name)),
      );
      if (missing.length > 0) {
        registerMcpTools(this.registry, config.name, missing, client, {
          risk: config.risk,
        });
      }
      entry.hasConnected = true;
      entry.reconnectAttempts = 0;
      this.updateStatus(entry, {
        state: 'connected',
        serverInfo: info.serverInfo,
        protocolVersion: info.protocolVersion,
        toolCount: descriptors.length,
        error: undefined,
        connectedAt: Date.now(),
      });
    } catch (caught) {
      if (entry.hasConnected) {
        this.scheduleReconnect(entry, caught);
      } else {
        this.updateStatus(entry, {
          state: 'failed',
          error: formatConnectError(caught),
          lastErrorAt: Date.now(),
        });
      }
    }
  }

  /** 崩溃（传输意外关闭）：状态 disconnected + 调度退避重连。 */
  private handleUnexpectedClose(entry: ServerEntry): void {
    if (entry.stopped) return;
    this.updateStatus(entry, {
      state: 'disconnected',
      error: `连接断开（服务器崩溃或网络中断），正在自动重连（第 ${entry.reconnectAttempts + 1} 次）`,
      lastErrorAt: Date.now(),
    });
    this.scheduleReconnect(entry, undefined);
  }

  /** 调度一次退避重连（指数退避：base × 2^n，封顶 max；幂等）。 */
  private scheduleReconnect(entry: ServerEntry, cause: unknown): void {
    if (entry.stopped || entry.reconnectTimer !== null) return;
    const attempt = entry.reconnectAttempts;
    entry.reconnectAttempts += 1;
    const delay = Math.min(
      this.reconnectBaseMs * 2 ** Math.min(attempt, 10),
      this.reconnectMaxMs,
    );
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      if (entry.stopped) return;
      this.updateStatus(entry, {
        state: 'connecting',
        error: formatReconnectError(cause, attempt + 1),
      });
      void this.connectServer(entry);
    }, delay);
  }
}

/** 连接失败的可诊断文本（区分协议错误与一般错误）。 */
function formatConnectError(caught: unknown): string {
  if (caught instanceof McpError) return `连接失败：${caught.message}`;
  if (caught instanceof Error) return `连接失败：${caught.message}`;
  return `连接失败：${String(caught)}`;
}

/** 重连失败的可诊断文本（区分协议错误与一般错误）。 */
function formatReconnectError(cause: unknown, attempt: number): string {
  const prefix = `正在重连（第 ${attempt} 次尝试失败）`;
  if (cause instanceof McpError) return `${prefix}：${cause.message}`;
  if (cause instanceof Error) return `${prefix}：${cause.message}`;
  return prefix;
}
