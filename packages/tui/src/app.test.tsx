import { afterAll, describe, expect, test } from 'bun:test';
import { render, cleanup } from 'ink-testing-library';
import type { Command, Envelope, ProtocolEvent } from '@modou/core';
import { App } from './app';
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
