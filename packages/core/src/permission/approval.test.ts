import { describe, expect, test } from 'bun:test';
import type { ProtocolEvent } from '../protocol/events';
import {
  ApprovalGate,
  APPROVAL_OPTIONS,
  DANGEROUS_APPROVAL_OPTIONS,
} from './approval';
import type { ApprovalRequestInput } from './approval';

/** 收集闸门发出的协议事件。 */
function collect(): {
  events: ProtocolEvent[];
  emit: (e: ProtocolEvent) => void;
} {
  const events: ProtocolEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

/** 常规 write 审批请求。 */
const WRITE_INPUT: ApprovalRequestInput = {
  toolName: 'bash',
  risk: 'exec',
  description: '执行命令：npm run test',
  command: 'npm run test',
  prefix: 'npm run test',
};

function approvalEvents(events: ProtocolEvent[]): ProtocolEvent[] {
  return events.filter(
    (e) => e.type === 'approval_request' || e.type === 'approval_resolved',
  );
}

function requestById(
  events: ProtocolEvent[],
  type: 'approval_request' | 'approval_resolved',
): ProtocolEvent[] {
  return events.filter((e) => e.type === type);
}

describe('ApprovalGate（T-033 最小审批闸门）', () => {
  test('未注入 decider：默认拒绝（无人值守安全默认）', async () => {
    const gate = new ApprovalGate();
    const { events, emit } = collect();
    const decision = await gate.requestApproval(WRITE_INPUT, emit);
    expect(decision).toBe('deny');
    expect(requestById(events, 'approval_request')).toHaveLength(1);
    expect(requestById(events, 'approval_resolved')).toHaveLength(1);
    const resolved = requestById(events, 'approval_resolved')[0];
    if (resolved.type === 'approval_resolved') {
      expect(resolved.data.decision).toBe('deny');
      expect(resolved.data.source).toBe('policy');
    }
  });

  test('allow_once：放行一次，approval_request / approval_resolved 配对', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'allow_once', source: 'user' }),
    });
    const { events, emit } = collect();
    const decision = await gate.requestApproval(WRITE_INPUT, emit);
    expect(decision).toBe('allow_once');

    const requests = requestById(events, 'approval_request');
    const resolved = requestById(events, 'approval_resolved');
    expect(requests).toHaveLength(1);
    expect(resolved).toHaveLength(1);
    // 同一请求 id 配对
    expect(requests[0].type === 'approval_request' && requests[0].data.id).toBe(
      resolved[0].type === 'approval_resolved' && resolved[0].data.id,
    );
    if (requests[0].type === 'approval_request') {
      expect(requests[0].data.description).toContain('npm run test');
      expect(requests[0].data.risk).toBe('exec');
      expect(requests[0].data.options).toEqual(APPROVAL_OPTIONS);
    }
    if (resolved[0].type === 'approval_resolved') {
      expect(resolved[0].data.decision).toBe('allow_once');
      expect(resolved[0].data.source).toBe('user');
    }
  });

  test('allow_once 只放行一次：第二次同样请求仍会再问', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'allow_once', source: 'user' };
      },
    });
    const { events, emit } = collect();
    await gate.requestApproval(WRITE_INPUT, emit);
    await gate.requestApproval(WRITE_INPUT, emit);
    expect(calls).toBe(2);
    expect(requestById(events, 'approval_request')).toHaveLength(2);
  });

  test('allow_always 记住前缀：第二次同前缀不再问（无事件）', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'allow_always', source: 'user' };
      },
    });
    const { events, emit } = collect();
    const first = await gate.requestApproval(WRITE_INPUT, emit);
    expect(first).toBe('allow_always');
    expect(calls).toBe(1);

    // 第二次：同工具同前缀 → 记忆命中，直接放行，不再发任何事件
    const second = await gate.requestApproval(WRITE_INPUT, emit);
    expect(second).toBe('allow_always');
    expect(calls).toBe(1);
    // 事件里只有第一次的 request/resolved 对
    expect(approvalEvents(events)).toHaveLength(2);
  });

  test('allow_always 前缀匹配：子前缀放行，不同命令再问', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'allow_always', source: 'user' };
      },
    });
    await gate.requestApproval(WRITE_INPUT); // 记住前缀 "npm run test"

    // "npm run test -- --watch" 以已允许前缀开头 → 放行
    const child = await gate.requestApproval({
      ...WRITE_INPUT,
      description: '执行命令：npm run test -- --watch',
      command: 'npm run test -- --watch',
      prefix: 'npm run test -- --watch',
    });
    expect(child).toBe('allow_always');
    expect(calls).toBe(1);

    // "npm run build" 不是该前缀的延续 → 再问
    const other = await gate.requestApproval({
      ...WRITE_INPUT,
      description: '执行命令：npm run build',
      command: 'npm run build',
      prefix: 'npm run build',
    });
    expect(other).toBe('allow_always'); // decider 又放行并记住
    expect(calls).toBe(2);
  });

  test('deny → 返回 deny，且不记记忆（之后仍要问）', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'deny', source: 'user' }),
    });
    const first = await gate.requestApproval(WRITE_INPUT);
    const second = await gate.requestApproval(WRITE_INPUT);
    expect(first).toBe('deny');
    expect(second).toBe('deny');
  });

  test('危险命令：allow_always 记忆命中仍强制逐次确认（每次都发请求）', async () => {
    const dangerous: ApprovalRequestInput = {
      toolName: 'bash',
      risk: 'exec',
      description: '执行命令：rm -rf /tmp/x',
      command: 'rm -rf /tmp/x',
      prefix: 'rm -rf /tmp/x',
    };
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'allow_always', source: 'user' };
      },
    });
    const { events, emit } = collect();

    const first = await gate.requestApproval(dangerous, emit);
    expect(first).toBe('allow_always');

    // 第二次同一危险命令：仍发 approval_request（记忆被跳过）
    const second = await gate.requestApproval(dangerous, emit);
    expect(second).toBe('allow_always');
    expect(calls).toBe(2); // decider 被调了两次
    expect(requestById(events, 'approval_request')).toHaveLength(2);

    // 危险命令的可选项不含「始终允许此前缀」
    const request = requestById(events, 'approval_request')[0];
    if (request.type === 'approval_request') {
      expect(request.data.options).toEqual(DANGEROUS_APPROVAL_OPTIONS);
      expect(request.data.options.some((o) => o.id === 'allow_always')).toBe(
        false,
      );
    }
  });

  test('危险命令：即使记忆里有普通前缀，也强制确认', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'allow_always', source: 'user' }),
    });
    // 先记住一个普通前缀 "rm"（本不会发生——rm 通常带 -rf，此处验证记忆不豁免）
    await gate.requestApproval({
      ...WRITE_INPUT,
      description: '执行命令：rm file.txt',
      command: 'rm file.txt',
      prefix: 'rm file.txt',
    });
    // 带 -rf 的危险变体：不因记忆放行，仍发请求
    const { events, emit } = collect();
    await gate.requestApproval(
      {
        ...WRITE_INPUT,
        description: '执行命令：rm -rf /tmp/x',
        command: 'rm -rf /tmp/x',
        prefix: 'rm -rf /tmp/x',
      },
      emit,
    );
    expect(requestById(events, 'approval_request')).toHaveLength(1);
  });

  test('read 风险：防御性直接放行，不发事件（0.3.0 不拦 read）', async () => {
    let calls = 0;
    const gate = new ApprovalGate({
      decider: async () => {
        calls += 1;
        return { decision: 'deny', source: 'user' };
      },
    });
    const { events, emit } = collect();
    const decision = await gate.requestApproval(
      { ...WRITE_INPUT, toolName: 'read', risk: 'read', prefix: '' },
      emit,
    );
    expect(decision).toBe('allow_once');
    expect(calls).toBe(0);
    expect(approvalEvents(events)).toHaveLength(0);
  });

  test('allow_always 记忆按工具隔离：bash 的记忆不豁免 write 工具', async () => {
    const gate = new ApprovalGate({
      decider: async () => ({ decision: 'allow_always', source: 'user' }),
    });
    await gate.requestApproval(WRITE_INPUT); // 记住 bash "npm run test"
    const writeCall: ApprovalRequestInput = {
      toolName: 'write',
      risk: 'write',
      description: '写入/编辑文件：/repo/src/a.ts',
      prefix: '/repo/src/a.ts',
    };
    // 不同工具 → 记忆不命中，走完整审批（decider 放行并记录）
    const { events, emit } = collect();
    const decision = await gate.requestApproval(writeCall, emit);
    expect(decision).toBe('allow_always');
    expect(requestById(events, 'approval_request')).toHaveLength(1);
  });

  test('decider 抛错：视同拒绝（fail-closed），事件仍配对', async () => {
    const gate = new ApprovalGate({
      decider: async () => {
        throw new Error('前端审批通道故障');
      },
    });
    const { events, emit } = collect();
    const decision = await gate.requestApproval(WRITE_INPUT, emit);
    expect(decision).toBe('deny');
    expect(requestById(events, 'approval_request')).toHaveLength(1);
    expect(requestById(events, 'approval_resolved')).toHaveLength(1);
  });

  test('阻塞等待：approval_request 先发出，裁决到达前调用未返回', async () => {
    let resolveDecider!: (v: {
      decision: 'allow_once';
      source: 'user';
    }) => void;
    const gate = new ApprovalGate({
      decider: () =>
        new Promise((resolve) => {
          resolveDecider = resolve;
        }),
    });
    const { events, emit } = collect();

    let settled = false;
    const pending = gate.requestApproval(WRITE_INPUT, emit).then((decision) => {
      settled = true;
      return decision;
    });

    // 等待 approval_request 已发出、裁决仍挂起
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(approvalEvents(events)).toHaveLength(1);
    expect(settled).toBe(false); // 阻塞中

    resolveDecider({ decision: 'allow_once', source: 'user' });
    const decision = await pending;
    expect(decision).toBe('allow_once');
    expect(settled).toBe(true);
    expect(requestById(events, 'approval_resolved')).toHaveLength(1);
  });
});
