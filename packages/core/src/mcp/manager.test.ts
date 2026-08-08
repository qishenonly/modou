import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ToolRegistry } from '../tools/registry';
import { runToolPipeline } from '../tools/pipeline';
import { McpManager, normalizeMcpServers } from './manager';
import type { McpServerConfig } from './manager';

// ---------------------------------------------------------------------------
// 辅助：最小 stdio server 配置（command = bun，args = fixtures/minimal-server.ts）
// ---------------------------------------------------------------------------

function minimalServerConfig(
  name: string,
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [join(import.meta.dir, 'fixtures', 'minimal-server.ts')],
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
  timeoutMs = 3000,
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

describe('McpManager 生命周期（T-163）', () => {
  test('start：并行连接 enabled server，注入工具，状态与工具数正确', async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager({
      servers: [minimalServerConfig('alpha'), minimalServerConfig('beta')],
      registry,
    });
    await manager.start();
    const statuses = manager.status();
    expect(statuses).toHaveLength(2);
    expect(statuses.every((s) => s.state === 'connected')).toBe(true);
    expect(statuses.every((s) => s.toolCount === 5)).toBe(true); // echo/add/fail/crash/hang
    expect(statuses[0].serverInfo?.name).toBe('minimal-server');
    expect(manager.activeToolCount).toBe(10);
    // 工具已注册（loop 视角无差别）
    expect(registry.has('mcp_alpha_echo')).toBe(true);
    expect(registry.has('mcp_beta_add')).toBe(true);
    await manager.stop();
  });

  test('初始连接失败：状态 failed + 错误记录（不自动重试）', async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager({
      servers: [
        minimalServerConfig('ghost', {
          command: '/nonexistent/mcp-command-xyz',
        }),
      ],
      registry,
    });
    await manager.start();
    const status = manager.status()[0];
    expect(status.state).toBe('failed');
    expect(status.error).toBeTruthy();
    expect(registry.size).toBe(0); // 未注入任何工具
    await manager.stop();
  });

  test('disabled server：不连接不注入（状态保持 disconnected）', async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager({
      servers: [minimalServerConfig('off', { enabled: false })],
      registry,
    });
    await manager.start();
    const status = manager.status()[0];
    expect(status.state).toBe('disconnected');
    expect(registry.size).toBe(0);
    await manager.stop();
  });

  test('崩溃隔离：一个 server 崩溃不影响另一个（其余功能照常）', async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager({
      servers: [minimalServerConfig('alpha'), minimalServerConfig('beta')],
      registry,
    });
    await manager.start();
    // alpha 的 crash 工具：杀死 alpha 子进程
    const crash = await runToolPipeline(
      { id: 'c1', name: 'mcp_alpha_crash', input: {} },
      { registry },
    );
    expect(crash.ok).toBe(false); // 崩溃 = 调用失败（错误即数据）
    // beta 不受影响：echo 照常工作
    const echo = await runToolPipeline(
      { id: 'c2', name: 'mcp_beta_echo', input: { text: 'still-alive' } },
      { registry },
    );
    expect(echo.ok).toBe(true);
    expect(echo.forModel).toBe('still-alive');
    await manager.stop();
  });

  test('崩溃重连：alpha 崩溃后 manager 自动重连，工具恢复可用', async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager({
      servers: [minimalServerConfig('alpha')],
      registry,
      reconnectBaseMs: 100,
      reconnectMaxMs: 500,
    });
    await manager.start();
    // 崩溃 alpha
    await runToolPipeline(
      { id: 'r1', name: 'mcp_alpha_crash', input: {} },
      { registry },
    );
    // 状态先进入 disconnected
    await waitForStatus(manager, 'alpha', (s) => s === 'disconnected');
    // 自动重连成功
    await waitForStatus(manager, 'alpha', (s) => s === 'connected');
    // 工具恢复可用（同一注册表条目，execute 闭包指向同一 client）
    const echo = await runToolPipeline(
      { id: 'r2', name: 'mcp_alpha_echo', input: { text: 'back-online' } },
      { registry },
    );
    expect(echo.ok).toBe(true);
    expect(echo.forModel).toBe('back-online');
    await manager.stop();
  });

  test('normalizeMcpServers：缺省补齐（transport 由 command/url 派生，risk 缺省 network）', () => {
    const configs = normalizeMcpServers({
      servers: {
        fs: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
        },
        web: { url: 'https://example.com/mcp' },
        tiny: { command: 'echo', enabled: false, risk: 'read' },
      },
    });
    expect(configs).toHaveLength(3);
    const fs = configs.find((c) => c.name === 'fs');
    expect(fs?.transport).toBe('stdio');
    expect(fs?.risk).toBe('network');
    expect(fs?.enabled).toBe(true);
    expect(fs?.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem']);
    const web = configs.find((c) => c.name === 'web');
    expect(web?.transport).toBe('http');
    expect(web?.url).toBe('https://example.com/mcp');
    const tiny = configs.find((c) => c.name === 'tiny');
    expect(tiny?.enabled).toBe(false);
    expect(tiny?.risk).toBe('read');
  });
});
