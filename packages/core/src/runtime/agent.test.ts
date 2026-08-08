import { describe, expect, test } from 'bun:test';
import type { ModelProvider, StreamEvent } from '../provider/types';
import { BudgetLedger } from '../context/budget';
import { ToolRegistry } from '../tools/registry';
import { readTool } from '../tools/impl/read';
import { grepTool } from '../tools/impl/grep';
import { globTool } from '../tools/impl/glob';
import { writeTool } from '../tools/impl/write';
import { bashTool } from '../tools/impl/bash';
import { taskTool, TASK_TOOL_NAME } from '../tools/impl/task';
import { AGENT_TOOL_NAME, createAgentTool } from '../tools/impl/agent';
import { runAgentTurn, type RunAgentTurnInput, type TurnResult } from './loop';
import {
  buildAgentSystemPrompt,
  createAgentRunner,
  deriveAgentRegistry,
} from './agent';
import type { AgentDispatchRequest } from '../tools/types';

/**
 * 自定义 agents 派发（0.17.0 T-170）：角色化子代理复用子代理运行时。
 * 覆盖 G-0.17.0 验收门：工具白名单真正强制（越界调用被拒）与模型指定。
 */

const stubProvider: ModelProvider = {
  id: 'stub',
  modelId: 'stub-model',
  capabilities: {
    maxContext: 128_000,
    parallelToolCalls: false,
    cacheBreakpoints: false,
    images: false,
    thinking: 'none',
    strictJsonArgs: true,
  },
  async *streamChat() {
    yield { type: 'finish', reason: 'stop' } as StreamEvent;
  },
};

function okTurn(overrides?: Partial<TurnResult>): TurnResult {
  return {
    text: '角色完成',
    usage: { inputTokens: 10, outputTokens: 5 },
    budget: new BudgetLedger(),
    finishReason: 'stop',
    termination: 'end_turn',
    turns: 1,
    state: 'halted',
    readFiles: new Set(),
    ...overrides,
  };
}

/** 捕获 runTurn 入参的 stub（不真正执行模型）。 */
function captureRunTurn() {
  const seen: Array<{ input: RunAgentTurnInput; role: string }> = [];
  const runTurn = async (input: RunAgentTurnInput): Promise<TurnResult> => {
    const first = input.messages[0];
    const role =
      typeof first?.content === 'string' ? first.content : '(no user msg)';
    seen.push({ input, role });
    return okTurn();
  };
  return { seen, runTurn };
}

function parentRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    readTool,
    grepTool,
    globTool,
    writeTool,
    bashTool,
    taskTool,
  ]) {
    registry.register(tool);
  }
  return registry;
}

const REQUEST: AgentDispatchRequest = {
  name: 'reviewer',
  systemPrompt: '你是一名资深代码审查专家。',
  allowedTools: ['read', 'glob'],
  prompt: '请审查 src/main.ts 的改动。',
};

// ---------------------------------------------------------------------------
// 注册表派生（白名单强制）
// ---------------------------------------------------------------------------

describe('deriveAgentRegistry', () => {
  test('白名单非空 = 只含白名单内且父代理存在的工具——越界工具不在注册表', () => {
    const derived = deriveAgentRegistry(parentRegistry(), ['read', 'glob']);
    expect([...derived.names()].sort()).toEqual(['glob', 'read']);
    // 白名单外的工具根本不在注册表：模型调用在 ① Resolve 即被拒（未知工具）
    expect(derived.has('write')).toBe(false);
    expect(derived.has('bash')).toBe(false);
  });

  test('白名单里父代理没有的工具名静默跳过（权限继承不超父，ADR 0011）', () => {
    const derived = deriveAgentRegistry(parentRegistry(), [
      'read',
      'not-a-tool',
    ]);
    expect(derived.names()).toEqual(['read']);
  });

  test('白名单为空 = 继承父代理完整工具集（未声明 allowedTools 的语义）', () => {
    const derived = deriveAgentRegistry(parentRegistry(), []);
    const names = derived.names();
    for (const name of ['read', 'grep', 'glob', 'write', 'bash']) {
      expect(names).toContain(name);
    }
  });

  test('task 工具永不进入角色注册表（一层深限制，ADR 0011 双保险）', () => {
    const derived = deriveAgentRegistry(parentRegistry(), [
      'read',
      TASK_TOOL_NAME,
    ]);
    expect(derived.has(TASK_TOOL_NAME)).toBe(false);
    expect(derived.names()).toEqual(['read']);
  });

  test('agent 工具永不进入角色注册表（0.17.0 design-checker 偏离 4：派发型工具一并剔除）', () => {
    const registry = new ToolRegistry();
    registry.register(readTool);
    registry.register(createAgentTool({ resolve: () => undefined }));
    registry.register(taskTool);
    // 未声明白名单 = 继承父代理完整工具集——继承同样剔除 agent / task
    const derived = deriveAgentRegistry(registry, []);
    expect(derived.has(AGENT_TOOL_NAME)).toBe(false);
    expect(derived.has(TASK_TOOL_NAME)).toBe(false);
    expect(derived.names()).toEqual(['read']);
  });

  test('白名单显式列出 agent / task 也被剔除（剔除不依赖白名单内容）', () => {
    const registry = new ToolRegistry();
    registry.register(readTool);
    registry.register(createAgentTool({ resolve: () => undefined }));
    const derived = deriveAgentRegistry(registry, [
      'read',
      AGENT_TOOL_NAME,
      TASK_TOOL_NAME,
    ]);
    expect(derived.names()).toEqual(['read']);
  });

  test('父注册表 undefined = 空注册表（无工具）', () => {
    const derived = deriveAgentRegistry(undefined, []);
    expect(derived.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 系统提示词（角色化）
// ---------------------------------------------------------------------------

describe('buildAgentSystemPrompt', () => {
  test('角色名 + 角色提示词拼入系统提示词', () => {
    const registry = deriveAgentRegistry(
      parentRegistry(),
      REQUEST.allowedTools,
    );
    const system = buildAgentSystemPrompt(registry, REQUEST);
    expect(system).toContain('## 角色：reviewer');
    expect(system).toContain('你是一名资深代码审查专家。');
    // 角色系统提示词与子代理同形态：普通系统提示词 + extra 追加段
    expect(system).toContain('可用工具');
  });
});

// ---------------------------------------------------------------------------
// 派发器
// ---------------------------------------------------------------------------

describe('createAgentRunner', () => {
  test('派发 = 一次带角色配置的 runAgentTurn：角色提示词进系统提示词、prompt 作首条 user 消息、注册表按白名单派生', async () => {
    const { seen, runTurn } = captureRunTurn();
    const runner = createAgentRunner({
      runTurn,
      provider: stubProvider,
      parentRegistry: parentRegistry(),
      readFiles: new Set<string>(),
      cwd: '/proj',
      depth: 0,
    });
    const result = await runner(REQUEST);
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const { input } = seen[0];
    expect(input.system).toContain('## 角色：reviewer');
    expect(input.system).toContain('你是一名资深代码审查专家。');
    expect(input.messages).toHaveLength(1);
    expect(input.messages[0].content).toBe('请审查 src/main.ts 的改动。');
    expect(input.cwd).toBe('/proj');
    expect([...(input.tools?.names() ?? [])].sort()).toEqual(['glob', 'read']);
    expect(input.options.maxTurns).toBe(10);
    expect(input.subagentDepth).toBe(1);
  });

  test('模型指定：agent 声明 model 时经 resolveModel 重建 provider', async () => {
    const resolvedProvider: ModelProvider = {
      id: 'stub',
      modelId: 'agent-model',
      capabilities: stubProvider.capabilities,
      async *streamChat() {
        yield { type: 'finish', reason: 'stop' } as StreamEvent;
      },
    };
    const resolved: string[] = [];
    const { seen, runTurn } = captureRunTurn();
    const runner = createAgentRunner({
      runTurn,
      provider: stubProvider,
      parentRegistry: parentRegistry(),
      readFiles: new Set<string>(),
      cwd: '/proj',
      depth: 0,
      resolveModel: (model) => {
        resolved.push(model);
        return model === 'gpt-4o' ? resolvedProvider : undefined;
      },
    });
    const result = await runner({
      ...REQUEST,
      model: 'gpt-4o',
    });
    expect(result.ok).toBe(true);
    expect(resolved).toEqual(['gpt-4o']);
    expect(seen[0].input.provider?.modelId).toBe('agent-model');
  });

  test('模型指定但 resolveModel 未装配 = 派发失败回喂可诊断错误', async () => {
    const { runTurn } = captureRunTurn();
    const runner = createAgentRunner({
      runTurn,
      provider: stubProvider,
      parentRegistry: parentRegistry(),
      readFiles: new Set<string>(),
      cwd: '/proj',
      depth: 0,
      // 未注入 resolveModel
    });
    const result = await runner({ ...REQUEST, model: 'gpt-4o' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('gpt-4o');
    expect(result.error).toContain('resolveModel');
  });

  test('模型指定但 resolveModel 解析失败 = 派发失败回喂可诊断错误', async () => {
    const { runTurn } = captureRunTurn();
    const runner = createAgentRunner({
      runTurn,
      provider: stubProvider,
      parentRegistry: parentRegistry(),
      readFiles: new Set<string>(),
      cwd: '/proj',
      depth: 0,
      resolveModel: () => undefined,
    });
    const result = await runner({ ...REQUEST, model: 'unknown-model' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown-model');
  });

  test('一层深：depth ≥ 1 的 loop 里派发直接拒绝（角色不能派发角色）', async () => {
    const { runTurn } = captureRunTurn();
    const runner = createAgentRunner({
      runTurn,
      provider: stubProvider,
      parentRegistry: parentRegistry(),
      readFiles: new Set<string>(),
      cwd: '/proj',
      depth: 1,
    });
    const result = await runner(REQUEST);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('一层深');
  });

  test('角色派发内部 Read 过的文件并入父集合（共享 Set 语义）', async () => {
    const readFiles = new Set<string>();
    const runTurn = async (): Promise<TurnResult> =>
      okTurn({
        readFiles: new Set(['/proj/src/main.ts']),
      });
    const runner = createAgentRunner({
      runTurn,
      provider: stubProvider,
      parentRegistry: parentRegistry(),
      readFiles,
      cwd: '/proj',
      depth: 0,
    });
    const result = await runner(REQUEST);
    expect(result.ok).toBe(true);
    expect(readFiles.has('/proj/src/main.ts')).toBe(true);
  });

  test('失败（非 end_turn）归一为 ok:false 并带可诊断错误', async () => {
    const runTurn = async (): Promise<TurnResult> =>
      okTurn({ termination: 'halted', text: '部分产出' });
    const runner = createAgentRunner({
      runTurn,
      provider: stubProvider,
      parentRegistry: parentRegistry(),
      readFiles: new Set<string>(),
      cwd: '/proj',
      depth: 0,
    });
    const result = await runner(REQUEST);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 端到端：agent 工具 → loop 接线 → 角色化子代理（白名单强制全链路）
// ---------------------------------------------------------------------------

function makeStubProvider(rounds: StreamEvent[][]): ModelProvider & {
  seen: string[];
  /** 每次请求里出现的 tool-result 错误文本（错误即数据的观测源）。 */
  toolErrors: string[];
} {
  let call = 0;
  const seen: string[] = [];
  const toolErrors: string[] = [];
  return {
    id: 'stub',
    modelId: 'stub-model',
    capabilities: stubProvider.capabilities,
    async *streamChat(input) {
      const first = input.messages[0];
      const text =
        typeof first?.content === 'string'
          ? first.content.slice(0, 60)
          : '(multi)';
      seen.push(text);
      for (const message of input.messages) {
        if (message.role !== 'tool' || typeof message.content === 'string')
          continue;
        for (const part of message.content) {
          if (
            part.type === 'tool-result' &&
            typeof part.output === 'object' &&
            part.output !== null &&
            (part.output as { type?: string }).type === 'error-text'
          ) {
            toolErrors.push(
              (part.output as { value?: unknown }).value as string,
            );
          }
        }
      }
      const round = rounds[Math.min(call, rounds.length - 1)];
      call += 1;
      for (const event of round) yield event;
    },
    seen,
    toolErrors,
  };
}

function useEvents(name: string, input: unknown): StreamEvent[] {
  return [
    { type: 'tool_use', id: 'call-agent', name, input },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
    { type: 'finish', reason: 'tool_use' },
  ];
}

function textRound(text: string): StreamEvent[] {
  return [
    ...Array.from(text).map((char) => ({
      type: 'text_delta' as const,
      delta: char,
    })),
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
    { type: 'finish', reason: 'stop' },
  ];
}

describe('agent 工具端到端（loop 接线）', () => {
  test('越界调用在角色派发内被拒：白名单只有 read，write 调用 → 未知工具', async () => {
    // 主代理轮次：调用 agent(reviewer) → 角色派发轮次：write（越界）→ 文本 →
    // 回主代理：文本收尾
    const stub = makeStubProvider([
      useEvents(AGENT_TOOL_NAME, {
        name: 'reviewer',
        prompt: '审查 src/main.ts',
      }),
      useEvents('write', { path: '/proj/evil.txt', content: 'x' }),
      textRound('我只有只读工具，无法写入。'),
      textRound('审查完成。'),
    ]);
    const tools = parentRegistry();
    // agent 工具注册到主代理注册表（角色解析器由「装配方」注入）
    tools.register(
      createAgentTool({
        resolve: (name) =>
          name === 'reviewer'
            ? {
                name: 'reviewer',
                systemPrompt: '你是一名资深代码审查专家。',
                allowedTools: ['read'],
              }
            : undefined,
        names: () => ['reviewer'],
      }),
    );
    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [{ role: 'user', content: '开始' }],
        tools,
        cwd: '/proj',
        options: { maxTurns: 8 },
      },
      () => {},
    );
    expect(result.termination).toBe('end_turn');
    // 消息序（stub 视角）：0=主代理首轮、1=角色派发首轮（任务指令）、
    // 2=角色派发 write 的 tool_result 轮、3=角色派发文本轮、4=回主代理文本轮
    // 角色派发的首条消息 = 任务指令（不携带父代理历史）
    expect(stub.seen[1]).toContain('审查 src/main.ts');
    // 角色派发的注册表只有 read：write 调用在 ① Resolve 即被拒（未知工具）
    expect(
      stub.toolErrors.some((error) => error.includes('未知工具 "write"')),
    ).toBe(true);
    // 主代理最终文本含角色结论
    expect(result.text).toContain('审查完成');
  });

  test('角色未声明白名单 = 继承父代理完整工具集（write 可用）', async () => {
    const stub = makeStubProvider([
      useEvents(AGENT_TOOL_NAME, { name: 'full', prompt: '改一下' }),
      textRound('已用完整工具集。'),
      textRound('完成。'),
    ]);
    const tools = parentRegistry();
    tools.register(
      createAgentTool({
        resolve: (name) =>
          name === 'full'
            ? {
                name: 'full',
                systemPrompt: '你有完整工具集。',
                allowedTools: [],
              }
            : undefined,
        names: () => ['full'],
      }),
    );
    const result = await runAgentTurn(
      {
        provider: stub,
        messages: [{ role: 'user', content: '开始' }],
        tools,
        cwd: '/proj',
        options: { maxTurns: 8 },
      },
      () => {},
    );
    expect(result.termination).toBe('end_turn');
    expect(result.text).toContain('完成');
  });
});
