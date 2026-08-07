import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ApprovalGate } from '../permission/approval';
import type { ProtocolEvent } from '../protocol/events';
import { runToolPipeline } from './pipeline';
import { ToolRegistry } from './registry';
import type { Tool } from './types';

/** 测试用 write 工具（risk: write，不真的落盘）。 */
const writeStub: Tool = {
  name: 'write-stub',
  description: '写入（测试用）',
  risk: 'write',
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  execute: async () => ({ ok: true, forModel: '已写入（stub）' }),
};

/** 测试用 exec 工具（risk: exec，不真的执行）。 */
const execStub: Tool = {
  name: 'exec-stub',
  description: '执行（测试用）',
  risk: 'exec',
  schema: z.object({ command: z.string().min(1) }),
  execute: async () => ({ ok: true, forModel: '已执行（stub）' }),
};

/** 测试用 read 工具（risk: read，0.3.0 不拦）。 */
const readStub: Tool = {
  name: 'read-stub',
  description: '读取（测试用）',
  risk: 'read',
  schema: z.object({ path: z.string().min(1) }),
  execute: async () => ({ ok: true, forModel: '内容（stub）' }),
};

function buildRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(writeStub)
    .register(execStub)
    .register(readStub);
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

function approvalEvents(events: ProtocolEvent[]): ProtocolEvent[] {
  return events.filter(
    (e) => e.type === 'approval_request' || e.type === 'approval_resolved',
  );
}

describe('runToolPipeline ③ Authorize（T-033 接入）', () => {
  test('write 工具被拦：deny → ok:false「被拒绝，别重试」，事件流完整配对', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'deny', source: 'user' }),
    });
    const { events, emit } = collectEvents();
    const outcome = await runToolPipeline(
      {
        id: 'call-1',
        name: 'write-stub',
        input: { path: '/a.ts', content: 'x' },
      },
      { registry: buildRegistry(), authorize: gate, emit },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('被拒绝');
    expect(outcome.forModel).toContain('别重试');
    expect(outcome.forModel).toContain('write-stub');

    // 事件流：tool_call → approval_request → approval_resolved → tool_result(ok:false)
    expect(events.map((e) => e.type)).toEqual([
      'tool_call',
      'approval_request',
      'approval_resolved',
      'tool_result',
    ]);
    const result = events[3];
    if (result.type === 'tool_result') {
      expect(result.data.ok).toBe(false);
      expect(result.data.forModel).toContain('被拒绝');
    }
  });

  test('exec 工具被拦：deny 同样回策略性拒绝', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'deny', source: 'user' }),
    });
    const { events, emit } = collectEvents();
    const outcome = await runToolPipeline(
      { id: 'call-2', name: 'exec-stub', input: { command: 'npm run test' } },
      { registry: buildRegistry(), authorize: gate, emit },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('被拒绝');
    const requests = approvalEvents(events).filter(
      (e) => e.type === 'approval_request',
    );
    expect(requests).toHaveLength(1);
    if (requests[0].type === 'approval_request') {
      expect(requests[0].data.description).toContain('npm run test');
    }
  });

  test('read 工具不拦：即使 gate 会 deny 也不触发审批，正常执行', async () => {
    let called = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        called += 1;
        return { decision: 'deny', source: 'user' };
      },
    });
    const { events, emit } = collectEvents();
    const outcome = await runToolPipeline(
      { id: 'call-3', name: 'read-stub', input: { path: '/a.ts' } },
      { registry: buildRegistry(), authorize: gate, emit },
    );

    expect(outcome.ok).toBe(true);
    expect(called).toBe(0);
    expect(approvalEvents(events)).toHaveLength(0);
  });

  test('allow_once：放行一次，工具执行', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'allow_once', source: 'user' }),
    });
    const { events, emit } = collectEvents();
    const outcome = await runToolPipeline(
      {
        id: 'call-4',
        name: 'write-stub',
        input: { path: '/a.ts', content: 'x' },
      },
      { registry: buildRegistry(), authorize: gate, emit },
    );
    expect(outcome.ok).toBe(true);
    expect(events.some((e) => e.type === 'approval_request')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
  });

  test('allow_always：第二次同前缀调用直接放行，不再触发审批', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'allow_always', source: 'user' }),
    });
    const { events, emit } = collectEvents();

    const first = await runToolPipeline(
      { id: 'call-5a', name: 'exec-stub', input: { command: 'npm run test' } },
      { registry: buildRegistry(), authorize: gate, emit },
    );
    expect(first.ok).toBe(true);
    expect(approvalEvents(events)).toHaveLength(2); // 第一次 request + resolved

    const second = await runToolPipeline(
      { id: 'call-5b', name: 'exec-stub', input: { command: 'npm run test' } },
      { registry: buildRegistry(), authorize: gate, emit },
    );
    expect(second.ok).toBe(true);
    // 记忆命中：第二次不发任何审批事件
    expect(approvalEvents(events)).toHaveLength(2);
  });

  test('未注入 authorize：write / exec 不拦截（0.2.0 行为兼容）', async () => {
    const outcome = await runToolPipeline(
      {
        id: 'call-6',
        name: 'write-stub',
        input: { path: '/a.ts', content: 'x' },
      },
      { registry: buildRegistry() },
    );
    expect(outcome.ok).toBe(true);
  });

  test('危险命令经管线：即使 decider 始终 allow_always，每次仍触发审批', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'allow_always', source: 'user' }),
    });
    const { events, emit } = collectEvents();
    const input = { command: 'rm -rf /tmp/x' };

    await runToolPipeline(
      { id: 'call-7a', name: 'exec-stub', input },
      { registry: buildRegistry(), authorize: gate, emit },
    );
    await runToolPipeline(
      { id: 'call-7b', name: 'exec-stub', input },
      { registry: buildRegistry(), authorize: gate, emit },
    );

    // 危险命令：两次调用都发 approval_request（记忆被跳过，强制逐次确认）
    const requests = approvalEvents(events).filter(
      (e) => e.type === 'approval_request',
    );
    expect(requests).toHaveLength(2);
    if (requests[0].type === 'approval_request') {
      expect(
        requests[0].data.options.some((o) => o.id === 'allow_always'),
      ).toBe(false);
    }
  });
});
