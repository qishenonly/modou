/**
 * 最小 MCP server（**仅测试用**，T-160~T-163 的契约测试夹具）。
 *
 * 自建而非引用第三方 server：离线、确定、可控——测试要验证的是客户端协议
 * 行为（握手 / 列举 / 调用 / 错误 / 崩溃），用行为已知的最小 server 才能断言
 * 精确语义（真实 filesystem / git / Playwright server 的连通验证留 TUI 冒烟或
 * 环境说明，见 ADR 0015「验收门」）。
 *
 * stdio 传输：stdin/stdout 换行分隔 JSON-RPC。tools：
 * - `echo`    { text: string }         → 原样返回 text；
 * - `add`     { a: number, b: number } → 返回 a + b；
 * - `fail`    {}                       → 恒 isError:true（错误即数据路径）；
 * - `crash`   {}                       → 进程退出（模拟崩溃，T-163 重连测试）；
 * - `hang`    {}                       → 不响应（超时路径测试）。
 *
 * 本文件可被 `bun <path>` 直接启动（子进程形态），也被测试 import 的
 * createMinimalMcpServer()（进程内形态，HTTP 测试用）复用。
 */

import { createInterface } from 'node:readline';

/** 工具执行表（进程内形态与子进程形态共用）。 */
export function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): { content: unknown; isError?: boolean } {
  switch (name) {
    case 'echo': {
      const text = typeof args.text === 'string' ? args.text : '';
      return { content: [{ type: 'text', text }] };
    }
    case 'add': {
      const a = typeof args.a === 'number' ? args.a : 0;
      const b = typeof args.b === 'number' ? args.b : 0;
      return { content: [{ type: 'text', text: String(a + b) }] };
    }
    case 'fail':
      return {
        content: [{ type: 'text', text: '这个工具永远失败（测试用）' }],
        isError: true,
      };
    case 'crash':
      process.exit(17); // 模拟服务器崩溃
      return { content: [] };
    default:
      return {
        content: [
          {
            type: 'text',
            text: `未知工具 "${name}"（最小测试 server）`,
          },
        ],
        isError: true,
      };
  }
}

/** 一次工具调用是否「不响应」（hang 模拟卡死服务器，超时路径测试）。 */
export function shouldIgnoreToolCall(name: string): boolean {
  return name === 'hang';
}

/** 最小 server 暴露的工具描述（与 handleToolCall 对齐）。 */
export function minimalToolsList(): unknown[] {
  return [
    {
      name: 'echo',
      description: '原样返回传入的 text（测试工具）',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'add',
      description: '返回 a + b（测试工具）',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
    },
    {
      name: 'fail',
      description: '恒失败的工具（isError 路径测试）',
      inputSchema: { type: 'object' },
    },
    {
      name: 'crash',
      description: '调用后进程退出（崩溃重连测试）',
      inputSchema: { type: 'object' },
    },
    {
      name: 'hang',
      description: '调用后不响应（超时路径测试）',
      inputSchema: { type: 'object' },
    },
  ];
}

/** 处理一条 JSON-RPC 请求，返回响应负载（null = 不响应，hang 工具用）。 */
export function handleRequest(message: {
  id: number;
  method: string;
  params?: unknown;
}): { jsonrpc: '2.0'; id: number; result: unknown } | null {
  const { id, method } = message;
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'minimal-server', version: '1.0.0' },
        },
      };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: minimalToolsList() } };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      if (shouldIgnoreToolCall(toolName)) return null; // hang：不响应
      const args =
        typeof params.arguments === 'object' && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      return {
        jsonrpc: '2.0',
        id,
        result: handleToolCall(toolName, args),
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

// —— 子进程形态：直接运行本文件时启动 stdio 循环 ——
// （通过 import.meta.main 判断——bun 特有；测试 import 本文件时不会触发）
if (import.meta.main) {
  // 测试钩子：设置 MINIMAL_SERVER_STDERR 时向 stderr 写一行（验证 stderr 转发）
  if (process.env.MINIMAL_SERVER_STDERR !== undefined) {
    process.stderr.write('minimal-server: 启动完成（stderr 钩子）\n');
  }
  const reader = createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const record = message as Record<string, unknown>;
    if (record.jsonrpc !== '2.0' || typeof record.method !== 'string') return;
    const id = typeof record.id === 'number' ? record.id : -1;
    if (id < 0) return; // 通知（无 id）不响应
    const response = handleRequest({
      id,
      method: record.method,
      params: record.params,
    });
    if (response !== null) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}
