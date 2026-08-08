import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { StdioTransport } from './stdio';
import { McpClient } from './client';
import { McpError } from './types';

/** 启动最小测试 server（stdio 子进程）并装配已连接的 McpClient。 */
function spawnMinimalServer() {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [join(import.meta.dir, 'fixtures', 'minimal-server.ts')],
  });
  const client = new McpClient('minimal', transport, {
    connectTimeoutMs: 5000,
    callTimeoutMs: 2000,
  });
  return { client, transport };
}

/** 启动 + 连接（每个用例独立子进程，互不污染）。 */
async function connectClient() {
  const { client, transport } = spawnMinimalServer();
  const info = await client.connect();
  return { client, transport, info };
}

describe('McpClient 协议握手（T-160）', () => {
  test('connect：initialize 握手 + initialized 通知，状态与身份正确', async () => {
    const { client, info } = await connectClient();
    expect(client.connected).toBe(true);
    expect(client.connectionState).toBe('connected');
    expect(info.serverInfo.name).toBe('minimal-server');
    expect(info.serverInfo.version).toBe('1.0.0');
    expect(info.protocolVersion).toBe('2025-06-18');
    await client.close();
  });

  test('connect 幂等：重复 connect 不重启子进程', async () => {
    const { client } = await connectClient();
    const again = await client.connect();
    expect(again.serverInfo.name).toBe('minimal-server');
    await client.close();
  });

  test('connect 失败：命令不存在 → McpError 可诊断（不抛非归一错误）', async () => {
    const transport = new StdioTransport({
      command: '/nonexistent/modou-mcp-command-xyz',
    });
    const client = new McpClient('ghost', transport);
    await expect(client.connect()).rejects.toBeInstanceOf(McpError);
    await expect(client.connect()).rejects.toMatchObject({
      message: expect.stringContaining('子进程失败'),
    });
  });
});

describe('McpClient tools/list（T-160）', () => {
  test('列举：返回服务器全部工具描述（含 inputSchema）', async () => {
    const { client } = await connectClient();
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'echo',
      'add',
      'fail',
      'crash',
      'hang',
    ]);
    const echo = tools.find((tool) => tool.name === 'echo');
    expect(echo?.description).toContain('原样返回');
    expect(echo?.inputSchema).toMatchObject({ type: 'object' });
    await client.close();
  });
});

describe('McpClient tools/call（T-160）', () => {
  test('成功调用：echo 原样返回文本', async () => {
    const { client } = await connectClient();
    const result = await client.callTool('echo', { text: '你好' });
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ type: 'text', text: '你好' });
    await client.close();
  });

  test('成功调用：add 返回数值和', async () => {
    const { client } = await connectClient();
    const result = await client.callTool('add', { a: 2, b: 3 });
    expect(result.content[0]).toMatchObject({ type: 'text', text: '5' });
    await client.close();
  });

  test('isError 路径：fail 工具返回错误内容（错误即数据）', async () => {
    const { client } = await connectClient();
    const result = await client.callTool('fail', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: '这个工具永远失败（测试用）',
    });
    await client.close();
  });

  test('未知工具：服务器回 isError 内容', async () => {
    const { client } = await connectClient();
    const result = await client.callTool('not_a_tool', {});
    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('McpClient 错误处理（T-160）', () => {
  test('调用前未连接：抛 McpError（连接状态说明）', async () => {
    const { client } = spawnMinimalServer();
    await expect(client.callTool('echo', { text: 'x' })).rejects.toMatchObject({
      message: expect.stringContaining('未连接'),
    });
  });

  test('超时：hang 工具不响应 → McpError 超时（可诊断）', async () => {
    const { client } = await connectClient();
    await expect(client.callTool('hang', {})).rejects.toMatchObject({
      message: expect.stringContaining('超时'),
    });
    await client.close();
  });

  test('服务器崩溃：crash 工具退出进程 → 在途请求拒绝且 onClose 触发', async () => {
    const { client } = await connectClient();
    let closed = 0;
    client.onClose(() => {
      closed += 1;
    });
    await expect(client.callTool('crash', {})).rejects.toBeInstanceOf(McpError);
    // 崩溃后 onClose 应已触发（close 回调是同步的，晚于 failAll）
    expect(closed).toBeGreaterThan(0);
    expect(client.connected).toBe(false);
  });

  test('close 后不可再用：调用抛 McpError（连接状态 closed）', async () => {
    const { client } = await connectClient();
    await client.close();
    await expect(client.callTool('echo', { text: 'x' })).rejects.toMatchObject({
      message: expect.stringContaining('连接状态：closed'),
    });
  });
});
