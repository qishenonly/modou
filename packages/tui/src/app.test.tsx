import { afterAll, describe, expect, test } from 'bun:test';
import { render, cleanup } from 'ink-testing-library';
import type {
  Command,
  ContextStateData,
  Envelope,
  ProtocolEvent,
  ResumeCandidate,
} from '@modou/core';
import { App } from './app';
import { createEventChannel } from './stream';
import { ZERO_TOKEN_TOTALS } from './status';

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

/**
 * 等 React / Ink 把状态变化渲染进帧（事件流消费是异步的，需要若干 tick）。
 * 自 T-042 起输出区走帧节流（默认 50ms 合并一次提交），等待时间要超过
 * 一个帧窗口 + 一个渲染周期，确保节流合并后的帧已落地。
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setTimeout(resolve, 40));
}

/** 构造一条 ResumeCandidate（T-061 /resume 选择器测试用）。 */
function resumeCandidate(
  sessionId: string,
  overrides: Partial<ResumeCandidate> = {},
): ResumeCandidate {
  return {
    projectHash: 'abc',
    sessionId,
    path: `/sessions/${sessionId}.jsonl`,
    firstTs: 1_700_000_000_000,
    lastTs: 1_700_000_100_000,
    maxSeq: 1,
    entryCount: 2,
    sizeBytes: 100,
    preview: '实现 /resume',
    ...overrides,
  };
}

describe('App（T-040 Ink 应用骨架）', () => {
  afterAll(() => {
    cleanup();
  });

  test('渲染应用框架：输入提示与初始状态', () => {
    const { stream } = createEventChannel();
    const { lastFrame, unmount } = render(
      <App stream={stream} send={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    // 底部输入行提示
    expect(frame).toContain('>');
    // 状态栏位初始状态（T-045 占位）
    expect(frame).toContain('就绪');
    expect(frame).toContain('turn 0');

    unmount();
  });

  test('事件流推送 text_delta 后，文本出现在输出区', async () => {
    const { stream, push } = createEventChannel();
    const { lastFrame, unmount } = render(
      <App stream={stream} send={() => {}} />,
    );

    push(env({ type: 'turn_start', data: { turn: 1 } }));
    await flush();
    // turn_start → 运行状态切换（状态栏位占位）
    expect(lastFrame() ?? '').toContain('运行中');

    push(env({ type: 'text_delta', data: { delta: '你' } }));
    push(env({ type: 'text_delta', data: { delta: '好' } }));
    await flush();
    expect(lastFrame() ?? '').toContain('你好');

    push(env({ type: 'turn_end', data: { turn: 1, termination: 'end_turn' } }));
    await flush();
    expect(lastFrame() ?? '').toContain('就绪');

    unmount();
  });

  test('tool_call / tool_result 事件流：工具调用列表创建并填充（T-043）', async () => {
    const { stream, push } = createEventChannel();
    const { lastFrame, unmount } = render(
      <App stream={stream} send={() => {}} />,
    );

    push(
      env({
        type: 'tool_call',
        data: { id: 'c1', name: 'edit', input: { path: '/a.ts' } },
      }),
    );
    await flush();
    // 折叠行：进行中标记 + 工具名 + 关键参数摘要
    expect(lastFrame() ?? '').toContain('… edit /a.ts');

    push(
      env({
        type: 'tool_result',
        data: {
          id: 'c1',
          ok: true,
          summary: 'Edit /a.ts：替换 1 处',
          forModel: '已替换 /a.ts',
          payload: {
            path: '/a.ts',
            replaced: true,
            occurrenceCount: 1,
            old_string: 'x',
            new_string: 'y',
          },
        },
      }),
    );
    await flush();
    // 结果填充：成功标记 + 摘要进入折叠行
    expect(lastFrame() ?? '').toContain('✓ edit Edit /a.ts：替换 1 处');

    unmount();
  });

  test('回车提交：输入非空触发 submit Command（空输入不提交）', async () => {
    const { stream } = createEventChannel();
    const calls: Command[] = [];
    const send = (command: Command): void => {
      calls.push(command);
    };
    const { stdin, unmount } = render(<App stream={stream} send={send} />);
    // Ink 的 useInput 在首次提交后的 effect 里才订阅 stdin（readable 事件），
    // 必须等订阅就绪再写入，否则事件丢失。
    await flush();

    // 空输入回车：不提交
    stdin.write('\r');
    expect(calls).toEqual([]);

    // 输入后回车：提交输入文本并清空输入行
    stdin.write('你好');
    stdin.write('\r');
    expect(calls).toEqual([{ type: 'submit', text: '你好' }]);

    unmount();
  });

  test('Esc 触发 interrupt Command', async () => {
    const { stream } = createEventChannel();
    const calls: Command[] = [];
    const send = (command: Command): void => {
      calls.push(command);
    };
    const { stdin, unmount } = render(<App stream={stream} send={send} />);
    await flush();

    stdin.write('\x1b');
    expect(calls).toEqual([{ type: 'interrupt' }]);

    unmount();
  });

  test('Ctrl+C 触发干净退出回调', async () => {
    const { stream } = createEventChannel();
    let exits = 0;
    const { stdin, unmount } = render(
      <App stream={stream} send={() => {}} onExit={() => (exits += 1)} />,
    );
    await flush();

    stdin.write('\x03'); // 0x03 = ctrl+c
    expect(exits).toBe(1);

    unmount();
  });
});

// ---------------------------------------------------------------------------
// /resume（T-061）：会话选择器 + 初始 token 种子
// ---------------------------------------------------------------------------

describe('App /resume（T-061）', () => {
  afterAll(() => {
    cleanup();
  });

  test('resumeCandidates 非空时显示会话选择器，输入行隐藏', async () => {
    const { stream } = createEventChannel();
    const { lastFrame, unmount } = render(
      <App
        stream={stream}
        send={() => {}}
        resumeCandidates={[resumeCandidate('sess-1')]}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('已保存的会话（/resume）');
    expect(frame).toContain('sess-1');
    // 选择器打开时输入行隐藏（不再显示 `>` 提示）
    expect(frame).not.toContain('>');
    unmount();
  });

  test('选择器打开时 Esc 不打断（interrupt 不发），数字键选择回传 sessionId', async () => {
    const { stream } = createEventChannel();
    const calls: Command[] = [];
    const selected: string[] = [];
    const { stdin, unmount } = render(
      <App
        stream={stream}
        send={(command) => calls.push(command)}
        resumeCandidates={[
          resumeCandidate('sess-a'),
          resumeCandidate('sess-b'),
        ]}
        onResumeSelect={(sessionId) => selected.push(sessionId)}
      />,
    );
    await flush();

    stdin.write('\x1b'); // 选择器打开：Esc 应被选择器消费，不发 interrupt
    expect(calls).toEqual([]);

    stdin.write('2'); // 数字键直接选择第二个会话
    expect(selected).toEqual(['sess-b']);
    unmount();
  });

  test('选择器打开时 Enter 选择当前项，Esc 走 onResumeCancel', async () => {
    const { stream } = createEventChannel();
    const calls: Command[] = [];
    const selected: string[] = [];
    let cancelled = 0;
    const { stdin, unmount } = render(
      <App
        stream={stream}
        send={(command) => calls.push(command)}
        resumeCandidates={[resumeCandidate('sess-a')]}
        onResumeSelect={(sessionId) => selected.push(sessionId)}
        onResumeCancel={() => (cancelled += 1)}
      />,
    );
    await flush();

    stdin.write('\r');
    expect(selected).toEqual(['sess-a']);
    expect(calls).toEqual([]);

    // 重新挂载一个（选中后 runTui 会 rerender 关闭选择器；这里模拟再次打开）
    const { stdin: stdin2, unmount: unmount2 } = render(
      <App
        stream={stream}
        send={(command) => calls.push(command)}
        resumeCandidates={[resumeCandidate('sess-a')]}
        onResumeCancel={() => (cancelled += 1)}
      />,
    );
    await flush();
    stdin2.write('\x1b');
    expect(cancelled).toBe(1);
    expect(calls).toEqual([]);
    unmount2();
    unmount();
  });

  test('initialTotals 种子进入状态栏（恢复后从历史累计开始）', async () => {
    const { stream } = createEventChannel();
    const { lastFrame, unmount } = render(
      <App
        stream={stream}
        send={() => {}}
        initialTotals={{
          ...ZERO_TOKEN_TOTALS,
          inputTokens: 20,
          outputTokens: 8,
        }}
      />,
    );
    expect(lastFrame() ?? '').toContain('in 20 / out 8');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// /context（T-063）：用量面板显示 + Esc 关闭
// ---------------------------------------------------------------------------

describe('App /context（T-063）', () => {
  afterAll(() => {
    cleanup();
  });

  const contextState: ContextStateData = {
    nearCompaction: false,
    sections: [
      { name: 'system', tokens: 1200 },
      { name: 'tools', tokens: 300 },
      { name: 'instructions', tokens: 0 },
      { name: 'history', tokens: 400 },
      { name: 'tool_output', tokens: 200 },
    ],
    total: 2100,
    drift: { estimated: 2300, actual: 2100, error: 200, rate: 200 / 2100 },
  };

  test('注入 contextState：显示分项面板，输入行隐藏（模态）', async () => {
    const { stream } = createEventChannel();
    const { lastFrame, unmount } = render(
      <App stream={stream} send={() => {}} contextState={contextState} />,
    );
    const frame = lastFrame() ?? '';
    // 面板内容（标题 + 分项 + 合计）
    expect(frame).toContain('/context 上下文用量');
    expect(frame).toContain('系统提示');
    expect(frame).toContain('工具输出');
    expect(frame).toContain('合计 2100 tokens');
    // 模态：输入行隐藏（不再显示 `>` 提示）
    expect(frame).not.toContain('>');
    unmount();
  });

  test('面板打开时 Esc 关闭（发 onContextDismiss，不触发 interrupt）', async () => {
    const { stream } = createEventChannel();
    const calls: Command[] = [];
    let dismissed = 0;
    const { stdin, unmount } = render(
      <App
        stream={stream}
        send={(command) => calls.push(command)}
        contextState={contextState}
        onContextDismiss={() => (dismissed += 1)}
      />,
    );
    await flush();

    stdin.write('\x1b'); // Esc
    expect(dismissed).toBe(1);
    expect(calls).toEqual([]); // 不向 core 发 interrupt
    unmount();
  });
});

// ---------------------------------------------------------------------------
// /compact（T-070）：斜杠命令触发 + compaction 事件展示
// ---------------------------------------------------------------------------

describe('App /compact（T-070）', () => {
  afterAll(() => {
    cleanup();
  });

  test('输入 /compact 提交：发 slash Command（name=compact，触发 runTui 手动压缩）', async () => {
    const { stream } = createEventChannel();
    const calls: Command[] = [];
    const send = (command: Command): void => {
      calls.push(command);
    };
    const { stdin, unmount } = render(<App stream={stream} send={send} />);
    await flush();

    stdin.write('/compact'); // 斜杠补全候选命中 /compact
    stdin.write('\r');
    expect(calls).toEqual([{ type: 'slash', name: 'compact' }]);
    unmount();
  });

  test('compaction 事件：提示「已压缩」（折叠轮次范围 + 压缩前后 token）', async () => {
    const { stream, push } = createEventChannel();
    const { lastFrame, unmount } = render(
      <App stream={stream} send={() => {}} />,
    );

    push(
      env({
        type: 'compaction',
        data: { beforeTokens: 1200, afterTokens: 300, coveredTurns: [1, 3] },
      }),
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('已压缩');
    expect(frame).toContain('折叠 1..3 轮');
    expect(frame).toContain('1200 → 300');
    unmount();
  });
});
