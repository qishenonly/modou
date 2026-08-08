import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { StdioTransport, isJsonRpcMessage } from './stdio';
import { McpError } from './types';

/** 直接操作 stdio 传输层（不经 McpClient）的启动辅助。 */
function startTransport(opts?: { env?: Record<string, string> }) {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [join(import.meta.dir, 'fixtures', 'minimal-server.ts')],
    ...(opts?.env !== undefined ? { env: opts.env } : {}),
  });
  return transport;
}

describe('StdioTransport 传输层（T-160）', () => {
  test('request：写请求 → 读响应，id 关联正确', async () => {
    const transport = startTransport();
    await transport.start();
    const response = await transport.request(
      { jsonrpc: '2.0', id: 42, method: 'ping', params: {} },
      { timeoutMs: 2000 },
    );
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 42 });
    expect('result' in response).toBe(true);
    transport.close();
  });

  test('并发请求：5 个并行请求各自按 id 取回对应响应', async () => {
    const transport = startTransport();
    await transport.start();
    const jobs = Array.from({ length: 5 }, (_, index) =>
      transport.request(
        {
          jsonrpc: '2.0',
          id: index + 1,
          method: 'tools/call',
          params: { name: 'add', arguments: { a: index, b: 10 } },
        },
        { timeoutMs: 2000 },
      ),
    );
    const responses = await Promise.all(jobs);
    for (let index = 0; index < 5; index += 1) {
      const response = responses[index];
      expect(response.id).toBe(index + 1);
      const result = (response as { result: { content: { text: string }[] } })
        .result;
      expect(result.content[0].text).toBe(String(index + 10));
    }
    transport.close();
  });

  test('stderr 转发：子进程写 stderr → onStderr 监听收到', async () => {
    const transport = startTransport({
      env: { MINIMAL_SERVER_STDERR: '1' },
    });
    const chunks: string[] = [];
    transport.onStderr((chunk) => chunks.push(chunk));
    await transport.start();
    // 等子进程把 stderr 钩子行写完（连接已建立即说明已执行）
    await transport.request(
      { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      { timeoutMs: 2000 },
    );
    expect(chunks.join('')).toContain('stderr 钩子');
    transport.close();
  });

  test('stdout 杂讯忽略：JSON 里混入的请求级语义只在 jsonrpc 字段存在时上抛', async () => {
    // 直接验证守卫函数：非 JSON-RPC 消息被拒（杂讯不串线）
    expect(isJsonRpcMessage({ hello: 'world' })).toBe(false);
    expect(isJsonRpcMessage('plain text')).toBe(false);
    expect(isJsonRpcMessage({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
    expect(isJsonRpcMessage({ jsonrpc: '2.0', method: 'x' })).toBe(true);
  });

  test('close 后请求被拒：抛 McpError（传输已关闭）', async () => {
    const transport = startTransport();
    await transport.start();
    transport.close();
    await expect(
      transport.request({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('已关闭'),
    });
  });

  test('超时：请求在 timeoutMs 内无响应 → McpError 超时', async () => {
    const transport = startTransport();
    await transport.start();
    await expect(
      transport.request(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'hang', arguments: {} },
        },
        { timeoutMs: 100 },
      ),
    ).rejects.toBeInstanceOf(McpError);
    await expect(
      transport.request(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'hang', arguments: {} },
        },
        { timeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('超时') });
    transport.close();
  });

  test('onClose：子进程崩溃触发关闭监听', async () => {
    const transport = startTransport();
    await transport.start();
    let closed = 0;
    transport.onClose(() => {
      closed += 1;
    });
    await expect(
      transport.request(
        {
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'crash', arguments: {} },
        },
        { timeoutMs: 2000 },
      ),
    ).rejects.toBeInstanceOf(McpError);
    expect(closed).toBeGreaterThan(0);
  });
});
