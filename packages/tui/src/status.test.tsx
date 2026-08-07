import { afterAll, describe, expect, test } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import type { Envelope, ProtocolEvent, UsageData } from '@modou/core';
import { App } from './app';
import { createEventChannel } from './stream';
import {
  PERMISSION_MODE_LABEL,
  StatusBar,
  ZERO_TOKEN_TOTALS,
  applyUsage,
  derivePermissionMode,
} from './status';

// ---------------------------------------------------------------------------
// 测试说明
// ---------------------------------------------------------------------------
// - 纯函数（applyUsage / derivePermissionMode）直接断言数据；
// - StatusBar 用 ink-testing-library 渲染断言段文本；非 TTY 帧不含 ANSI，
//   所以 dimColor 不影响断言（同 tools.test 的说明）；
// - App 集成（usage 累计 + 运行状态切换）用 createEventChannel 离线事件流，
//   不访问外网。App 消费事件是异步的，需要若干 tick 等渲染落地。
// ---------------------------------------------------------------------------

let counter = 0;

/** 构造一条协议信封（v1 信封：公共字段 + 判别事件，与 app.test 同款）。 */
function env(event: ProtocolEvent): Envelope {
  counter += 1;
  const turn =
    event.type === 'turn_start' || event.type === 'turn_end'
      ? event.data.turn
      : 0;
  return { v: 1, seq: counter, ts: 0, agent: 'main', turn, ...event };
}

/** 等 React / Ink 把状态变化渲染进帧（帧节流 50ms，等一个帧窗 + 渲染周期）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setTimeout(resolve, 40));
}

// ---------------------------------------------------------------------------
// applyUsage：usage 事件累进会话总量
// ---------------------------------------------------------------------------

describe('applyUsage（token 累计）', () => {
  test('累加 input / output / 缓存字段，返回全新对象不改传入总量', () => {
    const one = applyUsage(ZERO_TOKEN_TOTALS, {
      inputTokens: 120,
      outputTokens: 30,
    });
    expect(one).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // 第一次的结果不变（不可变更新）
    expect(ZERO_TOKEN_TOTALS).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    const two = applyUsage(one, {
      inputTokens: 80,
      outputTokens: 10,
      cacheReadTokens: 45,
    });
    expect(two).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 45,
      cacheWriteTokens: 0,
    });
    expect(one).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test('缺省字段按 0 计：全空 usage 不污染历史累计', () => {
    const after = applyUsage(
      applyUsage(ZERO_TOKEN_TOTALS, {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 7,
      }),
      {} as UsageData,
    );
    expect(after).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 7,
      cacheWriteTokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// derivePermissionMode：从工具注册表推导权限模式
// ---------------------------------------------------------------------------

describe('derivePermissionMode（权限模式推导）', () => {
  test('只有读工具或空注册表 → 只读', () => {
    expect(derivePermissionMode({ list: () => [] })).toBe('readonly');
    expect(derivePermissionMode({ list: () => [{ risk: 'read' }] })).toBe(
      'readonly',
    );
  });

  test('含写 / 执行 / 网络风险工具 → 写/执行需审批', () => {
    expect(
      derivePermissionMode({
        list: () => [{ risk: 'read' }, { risk: 'write' }],
      }),
    ).toBe('write-approval');
    expect(derivePermissionMode({ list: () => [{ risk: 'exec' }] })).toBe(
      'write-approval',
    );
    expect(derivePermissionMode({ list: () => [{ risk: 'network' }] })).toBe(
      'write-approval',
    );
  });
});

// ---------------------------------------------------------------------------
// StatusBar：渲染模型名 / 权限模式 / token / 运行状态
// ---------------------------------------------------------------------------

describe('StatusBar（状态栏渲染）', () => {
  afterAll(() => {
    cleanup();
  });

  test('渲染模型名 / 权限模式 / 累计 token / 就绪与轮次', () => {
    const { lastFrame, unmount } = render(
      <StatusBar
        modelName="deepseek-v4-flash"
        permissionMode="write-approval"
        totals={applyUsage(ZERO_TOKEN_TOTALS, {
          inputTokens: 100,
          outputTokens: 20,
        })}
        running={false}
        turn={2}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('deepseek-v4-flash');
    expect(frame).toContain(PERMISSION_MODE_LABEL['write-approval']);
    expect(frame).toContain('in 100 / out 20');
    expect(frame).toContain('○ 就绪');
    expect(frame).toContain('turn 2');

    unmount();
  });

  test('运行中标记与缓存命中显示；缺省段（模型名/权限模式）不显示', () => {
    const totals = applyUsage(
      applyUsage(ZERO_TOKEN_TOTALS, { inputTokens: 10, outputTokens: 1 }),
      { cacheReadTokens: 5 },
    );
    const { lastFrame, unmount } = render(
      <StatusBar totals={totals} running={true} turn={3} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('● 运行中');
    expect(frame).toContain('turn 3');
    expect(frame).toContain('cache +5');
    // 未注入模型名 / 权限模式时对应段不出现（App 独立渲染的缺省形态）
    expect(frame).not.toContain('只读');
    expect(frame).not.toContain('写/执行需审批');

    unmount();
  });

  test('只读模式标签渲染', () => {
    const { lastFrame, unmount } = render(
      <StatusBar
        permissionMode="readonly"
        totals={ZERO_TOKEN_TOTALS}
        running={false}
        turn={0}
      />,
    );
    expect(lastFrame() ?? '').toContain(PERMISSION_MODE_LABEL['readonly']);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// App 集成：usage 事件累计进状态栏；turn_start/turn_end 切换运行状态
// ---------------------------------------------------------------------------

describe('状态栏 App 集成（T-045）', () => {
  afterAll(() => {
    cleanup();
  });

  test('usage 事件逐次累加；turn_start/turn_end 切换运行状态', async () => {
    const { stream, push } = createEventChannel();
    const { lastFrame, unmount } = render(
      <App
        stream={stream}
        send={() => {}}
        modelName="deepseek-v4-flash"
        permissionMode="write-approval"
      />,
    );

    // 初始：就绪 + turn 0 + token 零值 + 模型名 / 权限模式
    let frame = lastFrame() ?? '';
    expect(frame).toContain('deepseek-v4-flash');
    expect(frame).toContain(PERMISSION_MODE_LABEL['write-approval']);
    expect(frame).toContain('○ 就绪');
    expect(frame).toContain('turn 0');
    expect(frame).toContain('in 0 / out 0');

    // turn_start → 运行中；usage 事件 → 累计
    push(env({ type: 'turn_start', data: { turn: 1 } }));
    push(env({ type: 'usage', data: { inputTokens: 120, outputTokens: 30 } }));
    await flush();
    frame = lastFrame() ?? '';
    expect(frame).toContain('● 运行中');
    expect(frame).toContain('turn 1');
    expect(frame).toContain('in 120 / out 30');

    // 第二轮 usage：累加而非覆盖（in 120+80 / out 30+10）
    push(env({ type: 'turn_end', data: { turn: 1, termination: 'end_turn' } }));
    push(env({ type: 'turn_start', data: { turn: 2 } }));
    push(env({ type: 'usage', data: { inputTokens: 80, outputTokens: 10 } }));
    await flush();
    frame = lastFrame() ?? '';
    expect(frame).toContain('in 200 / out 40');
    expect(frame).toContain('● 运行中');
    expect(frame).toContain('turn 2');

    // turn_end → 就绪（运行状态切换）
    push(env({ type: 'turn_end', data: { turn: 2, termination: 'end_turn' } }));
    await flush();
    expect(lastFrame() ?? '').toContain('○ 就绪');
    expect(lastFrame() ?? '').toContain('in 200 / out 40');

    unmount();
  });

  test('缓存命中字段累计后显示 cache +N', async () => {
    const { stream, push } = createEventChannel();
    const { lastFrame, unmount } = render(
      <App stream={stream} send={() => {}} />,
    );

    push(
      env({
        type: 'usage',
        data: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 30 },
      }),
    );
    await flush();
    expect(lastFrame() ?? '').toContain('in 50 / out 5');
    expect(lastFrame() ?? '').toContain('cache +30');

    unmount();
  });
});
