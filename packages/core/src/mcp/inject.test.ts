import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { ToolRegistry } from '../tools/registry';
import { runToolPipeline } from '../tools/pipeline';
import { runAgentTurn } from '../runtime/loop';
import type { ProviderCapabilities } from '../provider/capabilities';
import type { StreamChatInput, StreamEvent } from '../provider/types';
import { StdioTransport } from './stdio';
import { McpClient } from './client';
import { createMcpTool, mcpToolName, registerMcpTools } from './inject';
import type { McpToolDescriptor } from './types';
import { HookBus } from '../hooks/bus';

// ---------------------------------------------------------------------------
// 辅助：连接最小测试 server + 注入
// ---------------------------------------------------------------------------

async function connectClient() {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [join(import.meta.dir, 'fixtures', 'minimal-server.ts')],
  });
  const client = new McpClient('minimal', transport, {
    connectTimeoutMs: 5000,
    callTimeoutMs: 2000,
  });
  await client.connect();
  return client;
}

/** 最小 server 的工具描述（与 fixtures/minimal-server.ts 对齐的形态）。 */
const minimalDescriptors: readonly McpToolDescriptor[] = [
  {
    name: 'echo',
    description: '原样返回传入的 text（测试工具）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'add',
    description: '返回 a + b（测试工具）',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

describe('MCP 工具注入（T-162）', () => {
  test('命名空间隔离：注册名 mcp_<server>_<tool>，脱敏后唯一', () => {
    expect(mcpToolName('filesystem', 'read_file')).toBe(
      'mcp_filesystem_read_file',
    );
    expect(mcpToolName('My Server', 'Read-File!')).toBe(
      'mcp_my_server_read_file',
    );
    expect(mcpToolName('filesystem', '---')).toBe('mcp_filesystem_tool');
  });

  test('createMcpTool：schema 转换 + jsonSchema 原文透传 + risk 缺省 network', () => {
    const client = {} as McpClient; // 构造层面不触碰 client
    const tool = createMcpTool('minimal', minimalDescriptors[0], client);
    expect(tool.name).toBe('mcp_minimal_echo');
    expect(tool.risk).toBe('network');
    expect(tool.jsonSchema).toBe(minimalDescriptors[0].inputSchema); // 原文透传
    // schema：required text 生效（缺 text 校验失败）
    const parsed = (tool.schema as z.ZodType).safeParse({});
    expect(parsed.success).toBe(false);
    expect((tool.schema as z.ZodType).safeParse({ text: 'x' }).success).toBe(
      true,
    );
    // description 取服务器声明
    expect(tool.description).toContain('原样返回');
  });

  test('createMcpTool：risk 可覆盖；无描述时给占位（不静默）', () => {
    const tool = createMcpTool(
      'minimal',
      { name: 'x', inputSchema: { type: 'object' } },
      {} as McpClient,
      { risk: 'read' },
    );
    expect(tool.risk).toBe('read');
    expect(tool.description).toContain('服务器未提供描述');
  });

  test('registerMcpTools：批量注册成功；命名冲突抛错（防静默覆盖）', async () => {
    const client = await connectClient();
    const registry = new ToolRegistry();
    const names = registerMcpTools(
      registry,
      'minimal',
      minimalDescriptors,
      client,
    );
    expect(names).toEqual(['mcp_minimal_echo', 'mcp_minimal_add']);
    expect(registry.size).toBe(2);
    // 冲突：同 server 工具脱敏后与既有注册重名 → 抛错
    expect(() =>
      registerMcpTools(
        registry,
        'minimal',
        [{ name: 'echo', inputSchema: { type: 'object' } }],
        client,
      ),
    ).toThrow('工具名冲突');
    await client.close();
  });

  test('registry.toJsonSchema：注入工具返回服务器 inputSchema 原文', async () => {
    const client = await connectClient();
    const registry = new ToolRegistry();
    registerMcpTools(registry, 'minimal', minimalDescriptors, client);
    const schema = registry.toJsonSchema('mcp_minimal_echo') as Record<
      string,
      unknown
    >;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false); // 原文直通，不走 round-trip
    await client.close();
  });
});

describe('MCP 工具经执行管线（loop 视角无差别，T-162）', () => {
  test('runToolPipeline：调用注入的 MCP 工具成功（参数透传 + 结果回喂）', async () => {
    const client = await connectClient();
    const registry = new ToolRegistry();
    registerMcpTools(registry, 'minimal', minimalDescriptors, client);
    const outcome = await runToolPipeline(
      { id: 'call-1', name: 'mcp_minimal_echo', input: { text: '你好' } },
      { registry },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.forModel).toBe('你好');
    await client.close();
  });

  test('参数校验：缺 required 字段 → 本地拦截（附正确用法）', async () => {
    const client = await connectClient();
    const registry = new ToolRegistry();
    registerMcpTools(registry, 'minimal', minimalDescriptors, client);
    const outcome = await runToolPipeline(
      { id: 'call-2', name: 'mcp_minimal_echo', input: {} },
      { registry },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('参数校验失败');
    await client.close();
  });

  test('审批闸门：MCP 工具（network）经③ Authorize——deny 被拦截（与内置工具一致）', async () => {
    const client = await connectClient();
    const registry = new ToolRegistry();
    registerMcpTools(registry, 'minimal', minimalDescriptors, client);
    // 注入「一律拒绝」的审批闸门（同 ApprovalGate 缺省 decider 语义）
    const authorize = {
      requestApproval: async () => 'deny' as const,
    };
    const outcome = await runToolPipeline(
      { id: 'call-3', name: 'mcp_minimal_echo', input: { text: 'x' } },
      { registry, authorize: authorize as never },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('被拒绝');
    await client.close();
  });

  test('isError：服务器失败工具 → ok:false 回喂错误内容（错误即数据）', async () => {
    const client = await connectClient();
    const registry = new ToolRegistry();
    registerMcpTools(
      registry,
      'minimal',
      [{ name: 'fail', inputSchema: { type: 'object' } }],
      client,
    );
    const outcome = await runToolPipeline(
      { id: 'call-4', name: 'mcp_minimal_fail', input: {} },
      { registry },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('这个工具永远失败');
    await client.close();
  });

  test('钩子拦截：PreToolUse deny MCP 工具 → 阻止执行且理由回喂（与内置工具一致）', async () => {
    const client = await connectClient();
    const registry = new ToolRegistry();
    registerMcpTools(registry, 'minimal', minimalDescriptors, client);
    const hooks = new HookBus();
    hooks.register(
      'PreToolUse',
      async () => ({
        decision: 'deny' as const,
        reason: '测试钩子拒绝所有 MCP 调用',
      }),
      { id: 'mcp-deny-all' }, // 显式 ID：不消耗自动自增计数器（bus.test 依赖它）
    );
    const outcome = await runToolPipeline(
      { id: 'call-5', name: 'mcp_minimal_echo', input: { text: 'x' } },
      { registry, hooks },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('钩子拒绝');
    expect(outcome.forModel).toContain('测试钩子拒绝所有 MCP 调用');
    await client.close();
  });

  test('runAgentTurn（loop）：stub provider 发 tool_use → MCP 工具经管线执行并回喂', async () => {
    const client = await connectClient();
    const registry = new ToolRegistry();
    registerMcpTools(registry, 'minimal', minimalDescriptors, client);
    const provider = createStubProvider([
      {
        type: 'tool_use',
        id: 'mcp-call',
        name: 'mcp_minimal_add',
        input: { a: 40, b: 2 },
      },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
      { type: 'finish', reason: 'tool_use' },
    ]);
    const result = await runAgentTurn(
      {
        provider,
        system: 'test',
        messages: [{ role: 'user', content: '算一下 40+2' }],
        tools: registry,
        cwd: process.cwd(),
        options: { maxTurns: 3 },
      },
      () => {},
    );
    // loop 把 MCP 工具结果回喂进下一轮（thread 里出现 tool-result）
    const seen = provider.seenMessages;
    const last = seen[seen.length - 1];
    expect(last.some((message) => message.role === 'tool')).toBe(true);
    expect(result.termination).toBe('end_turn');
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// stub provider（与 runtime 测试同款，只发 tool_use 一轮）
// ---------------------------------------------------------------------------

const STUB_CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

class StubProvider {
  readonly id = 'stub';
  readonly modelId = 'stub-model';
  readonly capabilities: ProviderCapabilities = STUB_CAPABILITIES;
  readonly seenMessages: ModelMessage[][] = [];
  private callCount = 0;

  constructor(private readonly rounds: StreamEvent[][]) {}

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    this.seenMessages.push(input.messages);
    const round = this.rounds[Math.min(this.callCount, this.rounds.length - 1)];
    this.callCount += 1;
    if (input.abortSignal?.aborted) {
      throw new Error('aborted');
    }
    for (const event of round) yield event;
  }
}

function createStubProvider(events: StreamEvent[]): StubProvider {
  // 第二轮：纯文本收尾（end_turn）
  return new StubProvider([events, [{ type: 'finish', reason: 'stop' }]]);
}
