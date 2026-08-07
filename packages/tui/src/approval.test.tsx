import { afterAll, describe, expect, test } from 'bun:test';
import { render, cleanup } from 'ink-testing-library';
import type {
  ApprovalRequestData,
  Command,
  Envelope,
  ProtocolEvent,
} from '@modou/core';
import { App } from './app';
import { createApprovalBridge } from './approval';
import { createEventChannel } from './stream';

// ---------------------------------------------------------------------------
// 测试替身：离线事件流（createEventChannel）+ 信封构造（不访问外网）
// ---------------------------------------------------------------------------

let counter = 0;

/** 构造一条协议信封（v1 信封：公共字段 + 判别事件）。 */
function env(event: ProtocolEvent): Envelope {
  counter += 1;
  const turn =
    event.type === 'turn_start' || event.type === 'turn_end'
      ? event.data.turn
      : 0;
  return { v: 1, seq: counter, ts: 0, agent: 'main', turn, ...event };
}

/** 常规审批请求（三选项，与 core APPROVAL_OPTIONS 同形）。 */
function regularRequest(
  overrides: Partial<ApprovalRequestData> = {},
): ApprovalRequestData {
  return {
    id: 'req1',
    description: '执行命令：ls -la',
    risk: 'exec',
    options: [
      { id: 'allow_once', label: '允许本次' },
      { id: 'allow_always', label: '始终允许此前缀' },
      { id: 'deny', label: '拒绝' },
    ],
    ...overrides,
  };
}

/** 危险命令的请求（选项不含 allow_always，core 侧 T-033 强制逐次确认）。 */
function dangerousRequest(
  overrides: Partial<ApprovalRequestData> = {},
): ApprovalRequestData {
  return {
    id: 'req-danger',
    description: '执行命令：rm -rf /tmp/x',
    risk: 'exec',
    options: [
      { id: 'allow_once', label: '允许本次' },
      { id: 'deny', label: '拒绝' },
    ],
    ...overrides,
  };
}

/** 等 React / Ink 把状态变化渲染进帧（事件流消费是异步的，需要若干 tick）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setTimeout(resolve, 40));
}

// ---------------------------------------------------------------------------
// App 集成：弹窗展示 / 键盘裁决 / 关闭 / 输入阻塞
// ---------------------------------------------------------------------------

describe('App 审批弹窗（T-044）', () => {
  afterAll(() => {
    cleanup();
  });

  test('approval_request → 展示描述、风险级别与全部选项（输入行隐藏）', async () => {
    const { stream, push } = createEventChannel();
    const { lastFrame, unmount } = render(
      <App stream={stream} send={() => {}} />,
    );

    push(env({ type: 'approval_request', data: regularRequest() }));
    await flush();
    const frame = lastFrame() ?? '';

    // 描述（命令全文）与风险级别
    expect(frame).toContain('执行命令：ls -la');
    expect(frame).toContain('风险：执行');
    // 三个选项
    expect(frame).toContain('允许本次');
    expect(frame).toContain('始终允许此前缀');
    expect(frame).toContain('拒绝');
    // 弹窗打开期间输入行隐藏（> 提示不出现）
    expect(frame).not.toContain('>');

    unmount();
  });

  test('按 1 → 发 approve（allow_once），requestId 与请求一致', async () => {
    const { stream, push } = createEventChannel();
    const calls: Command[] = [];
    const { stdin, unmount } = render(
      <App stream={stream} send={(c) => calls.push(c)} />,
    );

    push(env({ type: 'approval_request', data: regularRequest() }));
    await flush();
    stdin.write('1');
    await flush();
    expect(calls).toEqual([
      { type: 'approve', requestId: 'req1', decision: 'allow_once' },
    ]);

    unmount();
  });

  test('按 2 → 发 approve（allow_always），按 3 → 发 approve（deny）', async () => {
    const { stream, push } = createEventChannel();
    const calls: Command[] = [];
    const { stdin, unmount } = render(
      <App stream={stream} send={(c) => calls.push(c)} />,
    );

    // 请求 A：按 2 → allow_always
    push(env({ type: 'approval_request', data: regularRequest({ id: 'a' }) }));
    await flush();
    stdin.write('2');
    await flush();
    expect(calls).toEqual([
      { type: 'approve', requestId: 'a', decision: 'allow_always' },
    ]);

    // 关闭弹窗（approval_resolved）后请求 B：按 3 → deny
    push(
      env({
        type: 'approval_resolved',
        data: { id: 'a', decision: 'allow_always', source: 'user' },
      }),
    );
    await flush();
    push(env({ type: 'approval_request', data: regularRequest({ id: 'b' }) }));
    await flush();
    stdin.write('3');
    await flush();
    expect(calls).toEqual([
      { type: 'approve', requestId: 'a', decision: 'allow_always' },
      { type: 'approve', requestId: 'b', decision: 'deny' },
    ]);

    unmount();
  });

  test('Esc → 发 approve（deny）；弹窗期间 App 不再发 interrupt', async () => {
    const { stream, push } = createEventChannel();
    const calls: Command[] = [];
    const { stdin, unmount } = render(
      <App stream={stream} send={(c) => calls.push(c)} />,
    );

    push(env({ type: 'approval_request', data: regularRequest() }));
    await flush();
    stdin.write('\x1b'); // Esc
    await flush();
    expect(calls).toEqual([
      { type: 'approve', requestId: 'req1', decision: 'deny' },
    ]);

    unmount();
  });

  test('↑/↓ + Enter：移动选中并裁决（↓→allow_always，↓↓→deny）', async () => {
    const { stream, push } = createEventChannel();
    const calls: Command[] = [];
    const { stdin, unmount } = render(
      <App stream={stream} send={(c) => calls.push(c)} />,
    );

    // 请求 A：↓ 选中第 2 项 → Enter = allow_always
    push(env({ type: 'approval_request', data: regularRequest({ id: 'a' }) }));
    await flush();
    stdin.write('\x1b[B'); // ↓
    stdin.write('\r'); // Enter
    await flush();
    expect(calls).toEqual([
      { type: 'approve', requestId: 'a', decision: 'allow_always' },
    ]);

    // 关闭后请求 B：↓↓ 选中第 3 项 → Enter = deny
    push(
      env({
        type: 'approval_resolved',
        data: { id: 'a', decision: 'allow_always', source: 'user' },
      }),
    );
    await flush();
    push(env({ type: 'approval_request', data: regularRequest({ id: 'b' }) }));
    await flush();
    stdin.write('\x1b[B');
    stdin.write('\x1b[B');
    stdin.write('\r');
    await flush();
    expect(calls[1]).toEqual({
      type: 'approve',
      requestId: 'b',
      decision: 'deny',
    });

    unmount();
  });

  test('approval_resolved → 关闭弹窗、恢复输入行；迟到的旧请求收尾不误关', async () => {
    const { stream, push } = createEventChannel();
    const { lastFrame, unmount } = render(
      <App stream={stream} send={() => {}} />,
    );

    push(env({ type: 'approval_request', data: regularRequest() }));
    await flush();
    expect(lastFrame() ?? '').toContain('允许本次');

    // 不匹配的 id（迟到旧请求收尾）→ 弹窗保持打开
    push(
      env({
        type: 'approval_resolved',
        data: { id: '别的请求', decision: 'deny', source: 'policy' },
      }),
    );
    await flush();
    expect(lastFrame() ?? '').toContain('允许本次');

    // 匹配的 id → 弹窗关闭，输入行恢复
    push(
      env({
        type: 'approval_resolved',
        data: { id: 'req1', decision: 'allow_once', source: 'user' },
      }),
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('允许本次');
    expect(frame).toContain('>');

    unmount();
  });

  test('弹窗期间输入提交被阻塞；关闭后恢复可提交', async () => {
    const { stream, push } = createEventChannel();
    const calls: Command[] = [];
    const { stdin, unmount } = render(
      <App stream={stream} send={(c) => calls.push(c)} />,
    );
    await flush();

    push(env({ type: 'approval_request', data: regularRequest() }));
    await flush();
    // 弹窗期间键入普通文本：输入行已隐藏，不产生任何 Command
    // （注意 Enter 在弹窗语义下是「裁决当前选中项」，不属于输入提交——本测试
    //  只验证「普通文本不提交输入」，Enter 的裁决语义由其他用例覆盖）
    stdin.write('hello');
    await flush();
    expect(calls).toEqual([]);

    // 裁决关闭弹窗后，输入行恢复并可正常提交
    push(
      env({
        type: 'approval_resolved',
        data: { id: 'req1', decision: 'deny', source: 'user' },
      }),
    );
    await flush();
    stdin.write('hi');
    stdin.write('\r');
    await flush();
    expect(calls).toEqual([{ type: 'submit', text: 'hi' }]);

    unmount();
  });

  test('危险命令选项不含 allow_always（core 已保证，TUI 透传）', async () => {
    const { stream, push } = createEventChannel();
    const calls: Command[] = [];
    const { stdin, lastFrame, unmount } = render(
      <App stream={stream} send={(c) => calls.push(c)} />,
    );

    push(env({ type: 'approval_request', data: dangerousRequest() }));
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('执行命令：rm -rf /tmp/x');
    expect(frame).toContain('允许本次');
    expect(frame).toContain('拒绝');
    expect(frame).not.toContain('始终允许此前缀');

    // 危险命令只有两项：2 → deny（allow_once 在 1）
    stdin.write('2');
    await flush();
    expect(calls).toEqual([
      { type: 'approve', requestId: 'req-danger', decision: 'deny' },
    ]);

    unmount();
  });
});

// ---------------------------------------------------------------------------
// createApprovalBridge：runTui 的审批裁决桥（approve Command → decider）
// ---------------------------------------------------------------------------

describe('createApprovalBridge（runTui 审批桥）', () => {
  test('resolve：用户裁决落地 decider，gate 返回决策且事件配对（source user）', async () => {
    const bridge = createApprovalBridge();
    const events: ProtocolEvent[] = [];
    let requestId = '';
    const emit = (event: ProtocolEvent): void => {
      events.push(event);
      if (event.type === 'approval_request') requestId = event.data.id;
    };

    const requestPromise = bridge.gate.requestApproval(
      {
        toolName: 'bash',
        risk: 'exec',
        description: '执行命令：ls -la',
        command: 'ls -la',
        prefix: 'ls -la',
      },
      emit,
    );

    // decider 已挂起：requestId 由 approval_request 事件捕获，resolve 命中
    expect(requestId.length).toBeGreaterThan(0);
    expect(bridge.resolve(requestId, 'allow_once')).toBe(true);
    expect(await requestPromise).toBe('allow_once');

    // approval_request / approval_resolved 事件配对，来源记 user
    const resolved = events.find((e) => e.type === 'approval_resolved');
    expect(resolved).toEqual({
      type: 'approval_resolved',
      data: { id: requestId, decision: 'allow_once', source: 'user' },
    });
    expect(events.filter((e) => e.type === 'approval_request')).toHaveLength(1);
  });

  test('resolve 未命中（id 不存在 / 已裁决）返回 false', async () => {
    const bridge = createApprovalBridge();
    let requestId = '';
    const requestPromise = bridge.gate.requestApproval(
      {
        toolName: 'bash',
        risk: 'exec',
        description: '执行命令：ls',
        command: 'ls',
        prefix: 'ls',
      },
      (event) => {
        if (event.type === 'approval_request') requestId = event.data.id;
      },
    );

    expect(bridge.resolve('不存在的id', 'allow_once')).toBe(false);
    expect(bridge.resolve(requestId, 'deny')).toBe(true);
    expect(bridge.resolve(requestId, 'allow_once')).toBe(false); // 已裁决
    expect(await requestPromise).toBe('deny');
  });

  test('denyAll：退出收尾，未裁决请求全部按拒绝 resolve（source 默认 policy）', async () => {
    const bridge = createApprovalBridge();
    const events: ProtocolEvent[] = [];
    const requestPromise = bridge.gate.requestApproval(
      {
        toolName: 'bash',
        risk: 'exec',
        description: '执行命令：ls',
        command: 'ls',
        prefix: 'ls',
      },
      (event) => events.push(event),
    );

    bridge.denyAll();
    expect(await requestPromise).toBe('deny');
    const resolved = events.find((e) => e.type === 'approval_resolved');
    expect(resolved?.data).toMatchObject({
      decision: 'deny',
      source: 'policy',
    });
  });
});
