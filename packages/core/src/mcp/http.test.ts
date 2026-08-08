import { describe, expect, test } from 'bun:test';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpTransport } from './http';
import { McpClient } from './client';
import { McpError } from './types';

/**
 * 最小 Streamable HTTP MCP server（仅测试用，T-161）。
 * - POST /：JSON-RPC 请求处理；响应统一以 text/event-stream 帧返回（覆盖 SSE
 *   解析路径）；initialize 时回 `Mcp-Session-Id` 头；notifications/initialized
 *   回 202 空体；tools/call 的 `hang` 不响应（超时路径测试）；
 * - GET /：保持长流，50ms 后发一条服务器主动通知（覆盖 GET SSE 长流解析）。
 */
class MinimalHttpMcpServer {
  readonly server: Server;
  private readonly sessionCounters: Record<string, number> = {};
  private connections = 0;

  constructor() {
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

  listen(): Promise<{ url: string; sessions: () => number }> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address() as AddressInfo;
        const sessions = (): number => this.connections;
        resolve({ url: `http://127.0.0.1:${port}/`, sessions });
      });
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
    }, 50);
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
});
