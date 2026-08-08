import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ApprovalGate } from '../permission/approval';
import { defaultPermissionConfig } from '../permission/policy';
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

// ---------------------------------------------------------------------------
// T-050 接入：管线 ③ Authorize 按 PermissionConfig 矩阵裁决（read 也会被拦）。
// ---------------------------------------------------------------------------

describe('runToolPipeline × PermissionConfig（T-050 接入）', () => {
  test('read-only 沙箱：write 被矩阵 deny，不经过审批流程（无 approval 事件）', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'allow_once', source: 'user' };
      },
      permission: {
        sandbox: 'read-only',
        policy: 'never',
        projectRoot: '/repo',
      },
    });
    const { events, emit } = collectEvents();
    const outcome = await runToolPipeline(
      {
        id: 'call-ro',
        name: 'write-stub',
        input: { path: '/a.ts', content: 'x' },
      },
      { registry: buildRegistry(), authorize: gate, emit },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('被拒绝');
    expect(calls).toBe(0); // 矩阵 deny 直通，decider 不被调用
    // 事件流：tool_call → tool_result(ok:false)，无 approval_request / resolved
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
  });

  test('read-only + untrusted：read 也问（矩阵「读也问」），放行后执行', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'allow_once', source: 'user' };
      },
      permission: {
        sandbox: 'read-only',
        policy: 'untrusted',
        projectRoot: '/repo',
      },
    });
    const { events, emit } = collectEvents();
    const outcome = await runToolPipeline(
      { id: 'call-rd', name: 'read-stub', input: { path: '/a.ts' } },
      { registry: buildRegistry(), authorize: gate, emit },
    );

    expect(outcome.ok).toBe(true);
    expect(calls).toBe(1);
    expect(approvalEvents(events)).toHaveLength(2); // request + resolved 配对
    const requests = approvalEvents(events).filter(
      (e) => e.type === 'approval_request',
    );
    if (requests[0].type === 'approval_request') {
      expect(requests[0].data.description).toContain('读取文件');
    }
  });

  test('MCP 工具审批描述带 server 身份前缀（origin，0.16.0 minor）', async () => {
    const mcpFs: Tool = {
      name: 'mcp_filesystem_write_file',
      description: '写文件（MCP filesystem）',
      risk: 'network',
      origin: 'filesystem',
      schema: z.object({ path: z.string().min(1) }),
      execute: async () => ({ ok: true, forModel: 'ok' }),
    };
    const mcpExec: Tool = {
      name: 'mcp_github_exec',
      description: '执行（MCP github）',
      risk: 'network',
      origin: 'github',
      schema: z.object({ command: z.string().min(1) }),
      execute: async () => ({ ok: true, forModel: 'ok' }),
    };
    const registry = new ToolRegistry().register(mcpFs).register(mcpExec);
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'allow_once', source: 'user' };
      },
      permission: defaultPermissionConfig('/repo'), // workspace-write + on-request
    });
    const { events, emit } = collectEvents();
    await runToolPipeline(
      {
        id: 'c-fs',
        name: 'mcp_filesystem_write_file',
        input: { path: '/repo/a.ts' },
      },
      { registry, authorize: gate, emit },
    );
    await runToolPipeline(
      {
        id: 'c-ex',
        name: 'mcp_github_exec',
        input: { command: 'create issue' },
      },
      { registry, authorize: gate, emit },
    );
    expect(calls).toBe(2);
    const requests = approvalEvents(events).filter(
      (e) => e.type === 'approval_request',
    );
    expect(requests).toHaveLength(2);
    if (requests[0].type === 'approval_request') {
      expect(requests[0].data.description).toContain(
        '[MCP filesystem] 写入/编辑文件：/repo/a.ts',
      );
    }
    if (requests[1].type === 'approval_request') {
      expect(requests[1].data.description).toContain(
        '[MCP github] 执行命令：create issue',
      );
    }
  });

  test('默认组合 workspace-write + on-request：read 直通、write 经审批', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'allow_once', source: 'user' };
      },
      permission: defaultPermissionConfig('/repo'),
    });
    const { events, emit } = collectEvents();

    // read：矩阵 allow 直通（无审批事件）
    const read = await runToolPipeline(
      { id: 'call-1', name: 'read-stub', input: { path: '/a.ts' } },
      { registry: buildRegistry(), authorize: gate, emit },
    );
    expect(read.ok).toBe(true);

    // write：矩阵 ask → 审批流程（decider 放行）
    const write = await runToolPipeline(
      {
        id: 'call-2',
        name: 'write-stub',
        input: { path: '/a.ts', content: 'x' },
      },
      { registry: buildRegistry(), authorize: gate, emit },
    );
    expect(write.ok).toBe(true);

    expect(calls).toBe(1); // 只有 write 触发 decider
    const requests = approvalEvents(events).filter(
      (e) => e.type === 'approval_request',
    );
    expect(requests).toHaveLength(1);
    if (requests[0].type === 'approval_request') {
      expect(requests[0].data.risk).toBe('write');
    }
  });
});
