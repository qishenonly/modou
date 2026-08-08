/**
 * 上下文分项估算（T-063 /context）离线测试：estimateContextSections 的分段计价
 * 与单调性、buildContextState 的协议负载组装、与 loop 请求级粗估的同源性。
 *
 * 全部离线：不访问网络、不依赖供应商。分段计价的「精度」只验证与
 * estimateTokens 一致（字符级近似，见 budget.ts），不与真实分词器逐 token
 * 对齐——对齐是 drift() 的职责（002 7.3）。
 */
import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { BudgetLedger, estimateTokens } from './budget';
import {
  buildContextState,
  CONTEXT_SECTION_NAMES,
  estimateContextSections,
  serializeMessageText,
  serializeToolsText,
} from './project';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';

// ---------------------------------------------------------------------------
// 测试替身：一条最小工具 + 一组典型消息线程
// ---------------------------------------------------------------------------

const echoTool: Tool = {
  name: 'echo',
  description: '原样返回输入的文本（测试用）',
  risk: 'read',
  schema: z.object({ text: z.string().min(1) }),
  execute: async () => ({ ok: true as const, forModel: 'echo' }),
};

function registryWithEcho(): ToolRegistry {
  return new ToolRegistry().register(echoTool);
}

/** 典型线程：user 输入 + assistant 文本/工具调用 + tool 输出（同轮归并）。 */
function typicalThread(): ModelMessage[] {
  return [
    { role: 'user', content: '请读一下 config.json' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '好的，我先读文件。' },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'echo',
          input: { text: '你好' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'echo',
          output: { type: 'text', value: 'echo:你好' },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// serializeMessageText / serializeToolsText（与 loop 请求级粗估同源）
// ---------------------------------------------------------------------------

describe('序列化（T-063 分段计价的数据源）', () => {
  test('serializeMessageText：string content 原样返回', () => {
    expect(serializeMessageText({ role: 'user', content: '你好' })).toBe(
      '你好',
    );
  });

  test('serializeMessageText：text / tool-call / tool-result 各就其位', () => {
    const message: ModelMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: '读文件' },
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'read',
          input: { path: 'a.ts' },
        },
      ],
    };
    expect(serializeMessageText(message)).toBe(
      '读文件\n[tool-call:read] {"path":"a.ts"}',
    );
  });

  test('serializeToolsText：含 name + description + JSON Schema', () => {
    const text = serializeToolsText(registryWithEcho());
    expect(text).toContain('echo: 原样返回输入的文本（测试用）');
    // JSON Schema 入列（JSON.stringify 无空格，`"type":"object"`）
    expect(text).toContain('"type":"object"');
  });
});

// ---------------------------------------------------------------------------
// estimateContextSections：分段计价
// ---------------------------------------------------------------------------

describe('estimateContextSections（002 7.1 分段估算）', () => {
  test('分项齐全（本地工具 + MCP 单列）、顺序与 CONTEXT_SECTION_NAMES 一致、合计为各段之和', () => {
    const system = '你是 modou，一个终端编码助手。';
    const tools = registryWithEcho();
    const thread = typicalThread();
    const estimate = estimateContextSections({ system, tools, thread });

    expect(estimate.sections.map((s) => s.name)).toEqual([
      ...CONTEXT_SECTION_NAMES,
    ]);
    expect(estimate.sections.map((s) => s.tokens)).toEqual([
      estimateTokens(system),
      estimateTokens(serializeToolsText(tools)),
      0, // mcp_tools 缺省 0（注册表无 mcp_* 工具时）
      0, // instructions 缺省 = 0 占位（0.8.0）
      estimateTokens(
        '请读一下 config.json\n好的，我先读文件。\n' +
          '[tool-call:echo] {"text":"你好"}',
      ),
      estimateTokens('[tool-result:echo] {"type":"text","value":"echo:你好"}'),
    ]);
    expect(estimate.total).toBe(
      estimate.sections.reduce((sum, s) => sum + s.tokens, 0),
    );
  });

  test('MCP 工具单列：mcp_* 前缀工具定义只进 mcp_tools 分项，不进 tools', () => {
    // 构造一个含 MCP 工具（mcp_filesystem_read_file）的注册表
    const mcpRegistry = new ToolRegistry();
    mcpRegistry.register({
      name: 'mcp_filesystem_read_file',
      description: '读取远程文件（MCP 测试工具）',
      risk: 'network',
      schema: z.record(z.string(), z.unknown()),
      jsonSchema: { type: 'object' },
      execute: async () => ({ ok: true, forModel: 'ok' }),
    });
    const estimate = estimateContextSections({
      system: 'sys',
      tools: mcpRegistry,
      thread: [],
    });
    const mcpTokens =
      estimate.sections.find((s) => s.name === 'mcp_tools')?.tokens ?? 0;
    const localTokens =
      estimate.sections.find((s) => s.name === 'tools')?.tokens ?? 0;
    expect(mcpTokens).toBeGreaterThan(0); // MCP 工具定义占位
    expect(localTokens).toBe(0); // 本地工具为空
    // 合计 = 所有分项之和（不重复计数）
    expect(estimate.total).toBe(
      estimate.sections.reduce((sum, s) => sum + s.tokens, 0),
    );
  });

  test('无工具注册表：tools 分项为 0', () => {
    const estimate = estimateContextSections({
      system: 'sys',
      thread: [],
    });
    expect(estimate.sections.find((s) => s.name === 'tools')?.tokens).toBe(0);
  });

  test('instructions 提供时按 estimateTokens 计价（0.8.0 前的占位可验证）', () => {
    const instructions = 'AGENTS.md 项目指令';
    const estimate = estimateContextSections({
      system: '',
      thread: [],
      instructions,
    });
    expect(
      estimate.sections.find((s) => s.name === 'instructions')?.tokens,
    ).toBe(estimateTokens(instructions));
  });

  test('对追加历史 / 工具输出单调不降（各段与合计）', () => {
    const base = estimateContextSections({
      system: 'sys',
      tools: registryWithEcho(),
      thread: [typicalThread()[0]], // 仅 user 消息
    });
    const grown = estimateContextSections({
      system: 'sys',
      tools: registryWithEcho(),
      thread: typicalThread(), // user + assistant + tool
    });
    for (const name of CONTEXT_SECTION_NAMES) {
      const before = base.sections.find((s) => s.name === name)?.tokens ?? 0;
      const after = grown.sections.find((s) => s.name === name)?.tokens ?? 0;
      expect(after).toBeGreaterThanOrEqual(before);
    }
    expect(grown.total).toBeGreaterThanOrEqual(base.total);
  });

  test('历史与工具输出分别计价：工具输出不进 history', () => {
    const tools = registryWithEcho();
    const thread = typicalThread();
    const estimate = estimateContextSections({ system: '', tools, thread });
    const history = estimate.sections.find((s) => s.name === 'history')?.tokens;
    const toolOutput = estimate.sections.find(
      (s) => s.name === 'tool_output',
    )?.tokens;
    // history 只含 user + assistant（不含 tool-result 文本）
    expect(history).toBe(
      estimateTokens(
        '请读一下 config.json\n好的，我先读文件。\n[tool-call:echo] {"text":"你好"}',
      ),
    );
    // tool_output 只含 tool 消息
    expect(toolOutput).toBeGreaterThan(0);
    expect(toolOutput).toBe(
      estimateTokens('[tool-result:echo] {"type":"text","value":"echo:你好"}'),
    );
  });

  test('与 loop 请求级粗估同源：合计 === system + 全线程 + tools 的 estimateTokens', () => {
    const system = 'sys prompt';
    const tools = registryWithEcho();
    const thread = typicalThread();
    const estimate = estimateContextSections({ system, tools, thread });
    const allText = [
      system,
      ...thread.map((message) => serializeMessageText(message)),
      serializeToolsText(tools),
    ].join('\n');
    expect(estimate.total).toBe(estimateTokens(allText));
  });

  test('budget 提供时 drift 透传；未提供时全零', () => {
    const ledger = new BudgetLedger();
    ledger.recordEstimate(120);
    ledger.recordUsage({ inputTokens: 100 });
    const withBudget = estimateContextSections({
      system: '',
      thread: [],
      budget: ledger,
    });
    expect(withBudget.drift).toEqual({
      estimated: 120,
      actual: 100,
      error: 20,
      rate: 0.2,
    });

    const withoutBudget = estimateContextSections({ system: '', thread: [] });
    expect(withoutBudget.drift).toEqual({
      estimated: 0,
      actual: 0,
      error: 0,
      rate: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// buildContextState：协议 context_state 负载
// ---------------------------------------------------------------------------

describe('buildContextState（协议负载组装，T-063）', () => {
  test('分项 + 合计 + drift + nearCompaction 齐全', () => {
    const ledger = new BudgetLedger();
    ledger.recordEstimate(120);
    ledger.recordUsage({ inputTokens: 100 });
    const state = buildContextState({
      system: 'sys',
      tools: registryWithEcho(),
      thread: typicalThread(),
      budget: ledger,
    });

    expect(state.sections.map((s) => s.name)).toEqual([
      ...CONTEXT_SECTION_NAMES,
    ]);
    expect(state.total).toBe(
      state.sections.reduce((sum, s) => sum + s.tokens, 0),
    );
    expect(state.drift).toEqual({
      estimated: 120,
      actual: 100,
      error: 20,
      rate: 0.2,
    });
    // 0.7.0 压缩之前恒 false
    expect(state.nearCompaction).toBe(false);
  });

  test('负载可 JSON 序列化且无 undefined 字段（协议约束）', () => {
    const state = buildContextState({
      system: 'sys',
      tools: registryWithEcho(),
      thread: typicalThread(),
      budget: new BudgetLedger(),
    });
    const text = JSON.stringify(state);
    const parsed = JSON.parse(text) as typeof state;
    expect(parsed.total).toBe(state.total);
    expect(
      Object.values(parsed.drift).every((v) => typeof v === 'number'),
    ).toBe(true);
  });
});
