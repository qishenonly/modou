/**
 * 钩子聚合函数（T-142 拦截与改写）离线测试。
 *
 * 覆盖：PreToolUse deny 阻止 + 理由回喂（经管线）；参数改写（改写的参数实际
 * 执行）；PostToolUse 观察 / 副作用（恒 continue，不改变结果）；UserPromptSubmit
 * 注入附加上下文 / 阻止提交；内联钩子崩溃保守兜底（PreToolUse deny）。
 *
 * 全部离线：内存 HookBus + 内联钩子，不 spawn 任何进程。
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { HookBus } from './bus';
import { runPostToolUse, runPreToolUse, runUserPromptSubmit } from './run';
import { runToolPipeline } from '../tools/pipeline';
import { ToolRegistry } from '../tools/registry';
import type { ProtocolEvent } from '../protocol/events';
import type { Tool } from '../tools/types';

/** 测试用回显工具：原样返回入参文本（复制自 tools.test.ts，保持离线）。 */
const echoTool: Tool = {
  name: 'echo',
  description: '原样返回输入的文本（测试用）',
  risk: 'read',
  schema: z.object({
    text: z.string().min(1),
    times: z.number().int().positive().optional(),
  }),
  execute: async (args: { text: string; times?: number }) => ({
    ok: true,
    forModel:
      args.times !== undefined ? args.text.repeat(args.times) : args.text,
    payload: { echoed: args.text },
  }),
};

function buildRegistry(): ToolRegistry {
  return new ToolRegistry().register(echoTool);
}

function collectEvents(): {
  events: ProtocolEvent[];
  emit: (event: ProtocolEvent) => void;
} {
  const events: ProtocolEvent[] = [];
  return {
    events,
    emit: (event) => {
      events.push(event);
    },
  };
}

function lastToolResult(
  events: ProtocolEvent[],
): { ok: boolean; forModel?: string } | undefined {
  const results = events.filter((event) => event.type === 'tool_result');
  if (results.length === 0) return undefined;
  const last = results[results.length - 1];
  return last.data as { ok: boolean; forModel?: string };
}

/** 经管线执行一次 echo 调用（可注入钩子总线）。 */
async function runEcho(
  input: { text: string; times?: number },
  hooks: HookBus | undefined,
): Promise<{
  events: ProtocolEvent[];
  outcome: { ok: boolean; forModel: string };
}> {
  const { events, emit } = collectEvents();
  const outcome = await runToolPipeline(
    { id: 'call-1', name: 'echo', input },
    { registry: buildRegistry(), hooks, emit },
  );
  return { events, outcome };
}

// ---------------------------------------------------------------------------
// PreToolUse：deny 阻止 + 理由回喂
// ---------------------------------------------------------------------------

describe('runPreToolUse：deny 阻止与理由回喂', () => {
  test('任一钩子 deny → 管线 ok:false，理由回喂模型，工具未执行', async () => {
    const bus = new HookBus();
    let executed = 0;
    // 注册一个「先读后用」守卫：拦截未读文件的 write —— 这里简化拦截所有 echo
    bus.register(
      'PreToolUse',
      async () => ({
        decision: 'deny',
        reason: '测试钩子：echo 被策略性拒绝，勿重试',
      }),
      { id: 'deny-echo', matcher: { tools: ['echo'] } },
    );
    // 工具 execute 本身正常（但不应被调起）
    const registry = new ToolRegistry().register({
      ...echoTool,
      execute: async () => {
        executed += 1;
        return { ok: true, forModel: 'SHOULD NOT RUN' };
      },
    });
    const { events, emit } = collectEvents();
    const outcome = await runToolPipeline(
      { id: 'c1', name: 'echo', input: { text: 'hi' } },
      { registry, hooks: bus, emit },
    );
    expect(executed).toBe(0); // ④ deny → ⑤ Execute 未发生
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('被钩子拒绝');
    expect(outcome.forModel).toContain('测试钩子：echo 被策略性拒绝，勿重试');
    const result = lastToolResult(events);
    expect(result?.ok).toBe(false);
  });

  test('多钩子均 deny → 理由合并；匹配器不命中的工具直通', async () => {
    const bus = new HookBus();
    bus.register(
      'PreToolUse',
      async () => ({ decision: 'deny', reason: '第一条理由' }),
      { id: 'a' },
    );
    bus.register(
      'PreToolUse',
      async () => ({ decision: 'deny', reason: '第二条理由' }),
      { id: 'b' },
    );
    const aggregate = await runPreToolUse(bus, {
      toolName: 'echo',
      toolInput: { text: 'hi' },
    });
    expect(aggregate.decision).toBe('deny');
    expect(aggregate.reasons).toEqual(['第一条理由', '第二条理由']);
  });
});

// ---------------------------------------------------------------------------
// PreToolUse：参数改写
// ---------------------------------------------------------------------------

describe('runPreToolUse：参数改写', () => {
  test('钩子改写参数 → 管线用改写后的参数执行', async () => {
    const bus = new HookBus();
    bus.register(
      'PreToolUse',
      async () => ({
        decision: 'allow',
        modifiedInput: { text: 'REWRITTEN', times: 2 },
      }),
      { id: 'rewrite', matcher: { tools: ['echo'] } },
    );
    const { events, outcome } = await runEcho({ text: 'original' }, bus);
    expect(outcome.ok).toBe(true);
    expect(outcome.forModel).toBe('REWRITTENREWRITTEN'); // 改写后 times=2
    const result = lastToolResult(events);
    expect(result?.forModel).toBe('REWRITTENREWRITTEN');
  });

  test('改写的参数不合法 → 按参数校验失败回喂模型（点名钩子侧）', async () => {
    const bus = new HookBus();
    bus.register(
      'PreToolUse',
      async () => ({
        decision: 'allow',
        modifiedInput: { text: '' }, // echo 要求 text ≥ 1
      }),
      { id: 'bad-rewrite', matcher: { tools: ['echo'] } },
    );
    const { events, outcome } = await runEcho({ text: 'original' }, bus);
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('钩子改写的参数不符合');
    const result = lastToolResult(events);
    expect(result?.ok).toBe(false);
  });

  test('最后一个改写的钩子有最终话语权（注册顺序靠后覆盖靠前）', async () => {
    const bus = new HookBus();
    bus.register(
      'PreToolUse',
      async () => ({ decision: 'allow', modifiedInput: { text: 'first' } }),
      { id: 'first' },
    );
    bus.register(
      'PreToolUse',
      async () => ({ decision: 'allow', modifiedInput: { text: 'second' } }),
      { id: 'second' },
    );
    const { outcome } = await runEcho({ text: 'original' }, bus);
    expect(outcome.forModel).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// PostToolUse：观察 / 副作用
// ---------------------------------------------------------------------------

describe('runPostToolUse：观察与副作用', () => {
  test('PostToolUse 钩子收到工具名 / 参数 / 结果，恒 continue 不改结果', async () => {
    const bus = new HookBus();
    let observed:
      | { toolName?: string; toolInput?: unknown; toolResult?: unknown }
      | undefined;
    bus.register(
      'PostToolUse',
      async (ctx) => {
        observed = {
          toolName: ctx.toolName,
          toolInput: ctx.toolInput,
          toolResult: ctx.toolResult,
        };
        return { decision: 'continue' };
      },
      { id: 'observer', matcher: { tools: ['echo'] } },
    );
    const { outcome } = await runEcho({ text: 'hi' }, bus);
    expect(outcome.ok).toBe(true);
    expect(outcome.forModel).toBe('hi');
    expect(observed).toEqual({
      toolName: 'echo',
      toolInput: { text: 'hi' },
      toolResult: { ok: true, forModel: 'hi' },
    });
  });

  test('runPostToolUse 聚合恒 continue（进程钩子降级也已在执行器层归 continue）', async () => {
    const bus = new HookBus();
    bus.register(
      'PostToolUse',
      async () => ({ decision: 'continue', reason: 'side effect' }),
      { id: 'fmt' },
    );
    const aggregate = await runPostToolUse(bus, {
      toolName: 'edit',
      toolInput: { path: 'a.ts' },
      toolResult: { ok: true, forModel: 'ok' },
    });
    expect(aggregate).toMatchObject({ decision: 'continue', errors: [] });
  });
});

// ---------------------------------------------------------------------------
// UserPromptSubmit：注入与阻止
// ---------------------------------------------------------------------------

describe('runUserPromptSubmit：注入与阻止', () => {
  test('allow 钩子注入附加上下文（多段换行合并），拼到提示词之后', async () => {
    const bus = new HookBus();
    bus.register(
      'UserPromptSubmit',
      async () => ({
        decision: 'allow',
        additionalContext: '-- 项目事实：Bun + TypeScript',
      }),
      { id: 'ctx-a' },
    );
    bus.register(
      'UserPromptSubmit',
      async () => ({
        decision: 'allow',
        additionalContext: '-- 规范：提交前跑 lint',
      }),
      { id: 'ctx-b' },
    );
    const aggregate = await runUserPromptSubmit(bus, '帮我写测试');
    expect(aggregate.decision).toBe('allow');
    expect(aggregate.additionalContext).toBe(
      '-- 项目事实：Bun + TypeScript\n\n-- 规范：提交前跑 lint',
    );
  });

  test('任一钩子 block → 阻止提交（首个 block 理由），后续注入被丢弃', async () => {
    const bus = new HookBus();
    bus.register(
      'UserPromptSubmit',
      async () => ({ decision: 'block', reason: '提交内容包含敏感词' }),
      { id: 'block' },
    );
    bus.register(
      'UserPromptSubmit',
      async () => ({ decision: 'allow', additionalContext: '不该出现' }),
      { id: 'inject' },
    );
    const aggregate = await runUserPromptSubmit(bus, '帮我删库');
    expect(aggregate.decision).toBe('block');
    expect(aggregate.reason).toBe('提交内容包含敏感词');
    expect(aggregate.additionalContext).toBeUndefined();
  });

  test('内联钩子崩溃 → 放行提交（allow 语义 fail-open）且说明有钩子出问题', async () => {
    const bus = new HookBus();
    bus.register(
      'UserPromptSubmit',
      async () => {
        throw new Error('hook boom');
      },
      { id: 'crash' },
    );
    const aggregate = await runUserPromptSubmit(bus, '帮我写测试');
    expect(aggregate.decision).toBe('allow');
    expect(aggregate.reason).toContain('hook boom');
  });

  test('内联钩子崩溃 → PreToolUse 按 deny 保守兜底（fail-closed 语义）', async () => {
    const bus = new HookBus();
    bus.register(
      'PreToolUse',
      async () => {
        throw new Error('guard boom');
      },
      { id: 'crash' },
    );
    const aggregate = await runPreToolUse(bus, {
      toolName: 'echo',
      toolInput: { text: 'hi' },
    });
    expect(aggregate.decision).toBe('deny');
    expect(aggregate.reasons.join('')).toContain('guard boom');
  });
});
