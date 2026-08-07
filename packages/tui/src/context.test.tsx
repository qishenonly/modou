/**
 * /context 用量面板（T-063）离线测试：分项条渲染（名称/token/占比）、
 * 合计 + drift 尾部、JSON 输出可解析。
 *
 * 全部离线：ContextStateData 是纯数据负载，测试直接构造，不依赖 core 事件流。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import type { ContextStateData } from '@modou/core';
import {
  CONTEXT_BAR_WIDTH,
  ContextPanel,
  formatContextFooter,
  formatContextRows,
} from './context';

// ---------------------------------------------------------------------------
// 测试替身：一份典型 context_state 负载
// ---------------------------------------------------------------------------

function sampleState(
  overrides: Partial<ContextStateData> = {},
): ContextStateData {
  return {
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 纯格式化函数
// ---------------------------------------------------------------------------

describe('formatContextRows / formatContextFooter（分项条 + 尾部，T-063）', () => {
  test('五行齐全、顺序与 002 7.1 分段一致、每行含标签/token/占比', () => {
    const rows = formatContextRows(sampleState());
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain('系统提示');
    expect(rows[1]).toContain('工具定义');
    expect(rows[2]).toContain('项目指令');
    expect(rows[3]).toContain('历史消息');
    expect(rows[4]).toContain('工具输出');
    // token 数进行
    expect(rows[0]).toContain('1200');
    expect(rows[4]).toContain('200');
    // 占比：1200/2100 ≈ 57.1%
    expect(rows[0]).toContain('57.1%');
  });

  test('占比条宽度固定为 CONTEXT_BAR_WIDTH（含填充字符）', () => {
    const rows = formatContextRows(sampleState());
    for (const row of rows) {
      // 条由 █ 与 ░ 组成（行内唯一的一串块状字符），合计宽度恒定
      const bar = row.match(/[█░]+/);
      expect(bar).not.toBeNull();
      if (bar !== null) expect(bar[0]).toHaveLength(CONTEXT_BAR_WIDTH);
    }
  });

  test('合计 + drift 尾部：含合计、粗估 vs 实测、偏差、压缩临近', () => {
    const footer = formatContextFooter(sampleState());
    expect(footer).toContain('合计 2100 tokens');
    expect(footer).toContain('粗估 2300 vs 实测 2100');
    expect(footer).toContain('偏差 200');
    expect(footer).toContain('9.5%'); // 200/2100
    expect(footer).toContain('压缩临近：否');
  });

  test('total 为 0 时占比取 0（避免除零）', () => {
    const rows = formatContextRows(sampleState({ total: 0, sections: [] }));
    for (const row of rows) expect(row).toContain('0.0%');
  });
});

// ---------------------------------------------------------------------------
// ContextPanel 渲染
// ---------------------------------------------------------------------------

describe('ContextPanel（Ink 渲染，T-063）', () => {
  afterAll(() => {
    cleanup();
  });

  test('渲染面板：标题、五个分项、合计尾部、关闭提示', () => {
    const { lastFrame, unmount } = render(
      <ContextPanel state={sampleState()} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/context 上下文用量');
    for (const label of [
      '系统提示',
      '工具定义',
      '项目指令',
      '历史消息',
      '工具输出',
    ]) {
      expect(frame).toContain(label);
    }
    expect(frame).toContain('合计 2100 tokens');
    expect(frame).toContain('Esc 关闭');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// JSON 输出（机器可读，供评测采集）
// ---------------------------------------------------------------------------

describe('JSON 输出可解析（/context --json，T-063）', () => {
  test('负载序列化往返：JSON.parse 与源负载一致', () => {
    const state = sampleState();
    const parsed = JSON.parse(JSON.stringify(state)) as ContextStateData;
    expect(parsed).toEqual(state);
    expect(parsed.total).toBe(2100);
    expect(parsed.drift).toEqual(state.drift);
    expect(parsed.sections).toHaveLength(5);
  });
});
