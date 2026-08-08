import { describe, expect, test } from 'bun:test';
import { createAgentTool, AGENT_TOOL_NAME, type AgentToolDeps } from './agent';
import type { AgentInfo } from './agent';
import type { ToolContext } from '../types';

/**
 * agent 工具（0.17.0 T-170）：按名派发自定义 agent（角色化子代理）。
 * 覆盖：角色解析 / 未知角色 / 未注入派发通道 / 派发参数透传。
 */

const REVIEWER: AgentInfo = {
  name: 'reviewer',
  systemPrompt: '你是一名资深代码审查专家。',
  allowedTools: ['read', 'glob'],
};

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    signal: new AbortController().signal,
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<AgentToolDeps>): AgentToolDeps {
  return {
    resolve: (name) => (name === 'reviewer' ? REVIEWER : undefined),
    names: () => ['reviewer'],
    ...overrides,
  };
}

describe('createAgentTool', () => {
  test('工具名与风险：agent / risk read（本工具自身不产生副作用）', () => {
    const tool = createAgentTool(makeDeps());
    expect(tool.name).toBe(AGENT_TOOL_NAME);
    expect(tool.risk).toBe('read');
    expect(tool.concurrent).toBe(true);
  });

  test('命中角色：经 ctx.runAgent 派发（角色配置 + prompt 透传）', async () => {
    const dispatched: unknown[] = [];
    const tool = createAgentTool(makeDeps());
    const outcome = await tool.execute(
      { name: 'reviewer', prompt: '审查 main.ts' },
      makeContext({
        runAgent: async (request) => {
          dispatched.push(request);
          return {
            ok: true,
            text: '结论：3 处问题',
            turns: 2,
            agentId: 'agent-reviewer-abcd',
          };
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(dispatched).toHaveLength(1);
    const request = dispatched[0] as {
      name: string;
      systemPrompt: string;
      allowedTools: readonly string[];
      prompt: string;
    };
    expect(request.name).toBe('reviewer');
    expect(request.systemPrompt).toBe('你是一名资深代码审查专家。');
    expect(request.allowedTools).toEqual(['read', 'glob']);
    expect(request.prompt).toBe('审查 main.ts');
    expect(outcome.forModel).toContain('结论：3 处问题');
    expect(outcome.forModel).toContain('reviewer');
  });

  test('角色指定 model 时透传', async () => {
    const dispatched: Array<{ model?: string }> = [];
    const deps = makeDeps({
      resolve: (name) =>
        name === 'reviewer' ? { ...REVIEWER, model: 'gpt-4o' } : undefined,
    });
    const tool = createAgentTool(deps);
    await tool.execute(
      { name: 'reviewer', prompt: 'x' },
      makeContext({
        runAgent: async (request) => {
          dispatched.push(request);
          return { ok: true, text: 'ok' };
        },
      }),
    );
    expect(dispatched[0].model).toBe('gpt-4o');
  });

  test('未知角色：ok:false 并列出可用角色（错误即数据，防模型臆造）', async () => {
    const tool = createAgentTool(makeDeps());
    const outcome = await tool.execute(
      { name: 'nonexistent', prompt: 'x' },
      makeContext(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('未知角色');
    expect(outcome.forModel).toContain('reviewer');
  });

  test('未注入 runAgent：ok:false 提示自定义 agent 不可用', async () => {
    const tool = createAgentTool(makeDeps());
    const outcome = await tool.execute(
      { name: 'reviewer', prompt: 'x' },
      makeContext(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('runAgent');
  });

  test('派发失败（ok:false）回喂可诊断错误', async () => {
    const tool = createAgentTool(makeDeps());
    const outcome = await tool.execute(
      { name: 'reviewer', prompt: 'x' },
      makeContext({
        runAgent: async () => ({
          ok: false,
          text: '部分产出',
          error: '自定义 agent 执行出错：模型超时',
        }),
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('模型超时');
    expect(outcome.forModel).toContain('reviewer');
  });

  test('schema 校验：name / prompt 必填', async () => {
    const tool = createAgentTool(makeDeps());
    const noName = tool.schema.safeParse({ prompt: 'x' });
    expect(noName.success).toBe(false);
    const noPrompt = tool.schema.safeParse({ name: 'reviewer' });
    expect(noPrompt.success).toBe(false);
    const ok = tool.schema.safeParse({ name: 'reviewer', prompt: 'x' });
    expect(ok.success).toBe(true);
  });
});
