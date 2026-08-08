import { describe, expect, test } from 'bun:test';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpTransport } from './http';
import { McpClient } from './client';
import { McpError } from './types';
import { McpManager } from './manager';
import type { McpServerConfig } from './manager';
import { ToolRegistry } from '../tools/registry';
import { runToolPipeline } from '../tools/pipeline';

/**
 * 最小 Streamable HTTP MCP server（仅测试用，T-161）。
 * - POST /：JSON-RPC 请求处理；响应统一以 text/event-stream 帧返回（覆盖 SSE
 *   解析路径）；initialize 时回 `Mcp-Session-Id` 头；notifications/initialized
 *   回 202 空体；tools/call 的 `hang` 不响应（超时路径测试）；
 * - GET /：保持长流，50ms 后发一条服务器主动通知（覆盖 GET SSE 长流解析）；
 *   `closeStreamAfterMs` 指定时在该时长后关闭长流（崩溃检测的「流关闭但服务器
 *   存活」路径测试）。
 * 崩溃检测测试用：`crash()` 强杀全部连接并关停服务器（模拟 HTTP server 崩溃）。
 */
class MinimalHttpMcpServer {
  readonly server: Server;
  private readonly sessionCounters: Record<string, number> = {};
  private readonly closeStreamAfterMs?: number;
  private connections = 0;

  constructor(options: { readonly closeStreamAfterMs?: number } = {}) {
    this.closeStreamAfterMs = options.closeStreamAfterMs;
    this.server = createServer((req, res) => {
      if (req.method === 'GET') {
        this.handleGet(req, res);
        return;
      }
      if (req.method === 'POST') {
        void this.handlePost(req, res);
        return;
      }
      res.writeHead(405).end();
    });
  }

  /** 监听（缺省随机端口；显式端口用于崩溃后同端口重启）。 */
  listen(
    port?: number,
  ): Promise<{ url: string; sessions: () => number; port: number }> {
    return new Promise((resolve) => {
      this.server.listen(port ?? 0, '127.0.0.1', () => {
        const bound = this.server.address() as AddressInfo;
        const sessions = (): number => this.connections;
        resolve({
          url: `http://127.0.0.1:${bound.port}/`,
          sessions,
          port: bound.port,
        });
      });
    });
  }

  /** 模拟崩溃：强杀全部连接（含 GET 长流）并关停服务器。 */
  crash(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      // 强制断开残留连接（GET 长流等），避免 close 等待悬挂
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  private handleGet(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): void {
    this.connections += 1;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // 50ms 后发一条服务器主动通知（progress 语义），随后保持连接不关闭
    setTimeout(() => {
      res.write(
        'event: message\n' +
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: 'token-1', progress: 0.5 },
          })}\n\n`,
      );
      if (this.closeStreamAfterMs !== undefined) {
        res.end(); // 模拟服务器主动关闭长流（服务器仍存活）
      }
    }, this.closeStreamAfterMs ?? 50);
    req.on('close', () => res.end());
  }

  private async handlePost(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    if (req.headers['mcp-session-id'] !== undefined) {
      this.connections += 1; // 会话头回传计数（连接数含 GET，此计数标识 POST 回传）
    }
    const body = await readBody(req);
    const message = JSON.parse(body) as Record<string, unknown>;
    const id = typeof message.id === 'number' ? message.id : null;
    if (id === null) {
      // 通知：202 Accepted 空体
      res.writeHead(202).end();
      return;
    }
    const result = handleRequest(
      id,
      typeof message.method === 'string' ? message.method : '',
      (message.params as Record<string, unknown>) ?? {},
    );
    if (message.method === 'initialize') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Mcp-Session-Id': 'sess-test-1',
      });
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    }
    if (result === null) {
      // hang：不写任何帧，让客户端超时（连接保持打开）
      req.on('close', () => res.end());
      return;
    }
    res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
    res.end();
  }
}

function handleRequest(
  id: number,
  method: string,
  params: Record<string, unknown>,
): { jsonrpc: '2.0'; id: number; result: unknown } | null {
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'http-minimal', version: '1.0.0' },
        },
      };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'echo',
              description: '原样返回传入的 text（HTTP 测试工具）',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
            {
              name: 'fail',
              description: '恒失败的工具',
              inputSchema: { type: 'object' },
            },
          ],
        },
      };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      if (toolName === 'hang') return null; // 不响应（超时路径）
      if (toolName === 'fail') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: 'HTTP 服务器返回的失败' }],
            isError: true,
          },
        };
      }
      const args = (params.arguments as Record<string, unknown>) ?? {};
      const text = typeof args.text === 'string' ? args.text : '';
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }], isError: false },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    default:
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `未知方法 ${method}` }],
          isError: true,
        },
      };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
    });
    req.on('end', () => resolve(text));
  });
}

/** 启动 HTTP 测试服务器并装配 McpClient。 */
async function setup() {
  const server = new MinimalHttpMcpServer();
  const { url, sessions } = await server.listen();
  const transport = new HttpTransport({
    url,
    requestTimeoutMs: 500,
    openServerStream: true,
  });
  const client = new McpClient('http-minimal', transport, {
    connectTimeoutMs: 500,
    callTimeoutMs: 800,
  });
  return { server, url, sessions, transport, client };
}

/** 构造 HTTP 形态的 McpServerConfig（manager 崩溃重连测试用）。 */
function httpServerConfig(
  name: string,
  url: string,
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    name,
    transport: 'http',
    url,
    enabled: true,
    risk: 'network',
    connectTimeoutMs: 5000,
    callTimeoutMs: 2000,
    ...overrides,
  };
}

/** 轮询状态直到满足谓词（崩溃重连测试用；超时抛错）。 */
async function waitForStatus(
  manager: McpManager,
  name: string,
  predicate: (state: string) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = manager.status().find((s) => s.name === name);
    if (status !== undefined && predicate(status.state)) return;
    if (Date.now() > deadline) {
      const all = manager
        .status()
        .map((s) => `${s.name}:${s.state}`)
        .join('，');
      throw new Error(`等待 ${name} 状态超时（当前：${all}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('HttpTransport / McpClient over HTTP（T-161）', () => {
  test('connect：initialize 握手（SSE 响应）+ initialized 通知 + 会话头', async () => {
    const { client, server } = await setup();
    const info = await client.connect();
    expect(client.connected).toBe(true);
    expect(info.serverInfo.name).toBe('http-minimal');
    expect(info.protocolVersion).toBe('2025-06-18');
    await client.close();
    await server.close();
  });

  test('会话头回传：initialize 后请求带 Mcp-Session-Id', async () => {
    const { client, sessions, server } = await setup();
    await client.connect();
    const before = sessions();
    await client.listTools();
    expect(sessions()).toBeGreaterThan(before); // tools/list 带上了会话头
    await client.close();
    await server.close();
  });

  test('tools/list：SSE 响应解析出工具描述', async () => {
    const { client, server } = await setup();
    await client.connect();
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'fail']);
    await client.close();
    await server.close();
  });

  test('tools/call：echo 成功、fail 走 isError（错误即数据）', async () => {
    const { client, server } = await setup();
    await client.connect();
    const ok = await client.callTool('echo', { text: 'hello-http' });
    expect(ok.isError).toBe(false);
    expect(ok.content[0]).toMatchObject({ type: 'text', text: 'hello-http' });
    const fail = await client.callTool('fail', {});
    expect(fail.isError).toBe(true);
    await client.close();
    await server.close();
  });

  test('超时：hang 工具不响应 → McpError 超时（可诊断）', async () => {
    const { client, server } = await setup();
    await client.connect();
    await expect(client.callTool('hang', {})).rejects.toMatchObject({
      message: expect.stringContaining('超时'),
    });
    await client.close();
    await server.close();
  });

  test('连接失败：端口未监听 → McpError 可诊断', async () => {
    const transport = new HttpTransport({
      url: 'http://127.0.0.1:1/',
      requestTimeoutMs: 500,
    });
    const client = new McpClient('down', transport);
    await expect(client.connect()).rejects.toBeInstanceOf(McpError);
  });

  test('GET 长流：服务器主动通知（progress）经 onNotification 收到', async () => {
    const { transport, client, server } = await setup();
    const notifications: string[] = [];
    transport.onNotification((notification) => {
      notifications.push(notification.method);
    });
    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 250)); // 等 GET 长流通知到达
    expect(notifications).toContain('notifications/progress');
    await client.close();
    await server.close();
  });

  test('崩溃检测：长流关闭但服务器存活 → 不触发 onClose（ping 探活通过）', async () => {
    // closeStreamAfterMs：服务器在发完通知后主动关闭 GET 长流，但 POST 照常服务
    const server = new MinimalHttpMcpServer({ closeStreamAfterMs: 60 });
    const { url } = await server.listen();
    const transport = new HttpTransport({
      url,
      requestTimeoutMs: 500,
      openServerStream: true,
    });
    const client = new McpClient('http-minimal', transport, {
      connectTimeoutMs: 500,
      callTimeoutMs: 800,
    });
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });
    await client.connect();
    // 等长流关闭 + 探活完成（探活成功 → 不触发 onClose，连接保持 connected）
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(closed).toBe(false);
    expect(client.connected).toBe(true);
    // POST 路径不受影响：工具照常可调
    const echo = await client.callTool('echo', { text: 'stream-closed' });
    expect(echo.content[0]).toMatchObject({
      type: 'text',
      text: 'stream-closed',
    });
    await client.close();
    await server.close();
  });

  test('崩溃检测：服务器崩溃（连接断开 + 探活失败）→ 触发 onClose', async () => {
    const server = new MinimalHttpMcpServer();
    const { url } = await server.listen();
    const transport = new HttpTransport({
      url,
      requestTimeoutMs: 500,
      openServerStream: true,
    });
    const client = new McpClient('http-minimal', transport, {
      connectTimeoutMs: 500,
      callTimeoutMs: 800,
    });
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });
    await client.connect();
    await server.crash(); // 强杀连接 + 关停
    const deadline = Date.now() + 3000;
    while (!closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(closed).toBe(true);
    expect(client.connected).toBe(false); // McpClient 回落未连接态
  });

  test('崩溃重连：HTTP server 崩溃 → manager disconnected → 同端口恢复 → 工具可用', async () => {
    const first = new MinimalHttpMcpServer();
    const { url, port } = await first.listen();
    const registry = new ToolRegistry();
    const manager = new McpManager({
      servers: [httpServerConfig('web', url)],
      registry,
      reconnectBaseMs: 100,
      reconnectMaxMs: 500,
    });
    await manager.start();
    expect(manager.status()[0].state).toBe('connected');
    // 崩溃：GET 长流断开 + 探活失败 → onClose → disconnected + 退避重连
    await first.crash();
    await waitForStatus(manager, 'web', (s) => s === 'disconnected');
    // 服务器在同端口回来 → 重连成功，工具恢复可用
    const second = new MinimalHttpMcpServer();
    await second.listen(port);
    await waitForStatus(manager, 'web', (s) => s === 'connected');
    const echo = await runToolPipeline(
      { id: 'e1', name: 'mcp_web_echo', input: { text: 'back-online' } },
      { registry },
    );
    expect(echo.ok).toBe(true);
    expect(echo.forModel).toBe('back-online');
    await manager.stop();
    await second.close();
  });
});
