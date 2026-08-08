import { afterAll, describe, expect, test } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import type { TodoItemData } from '@modou/core';
import {
  countStatuses,
  formatTodoBar,
  formatTodoRows,
  TodoList,
  TODO_BAR_WIDTH,
} from './todolist';

const ITEMS: readonly TodoItemData[] = [
  { id: 'a', text: '读取项目结构', status: 'done' },
  { id: 'b', text: '实现 TodoWrite', status: 'in_progress', dependsOn: ['a'] },
  { text: '写测试', status: 'pending' },
];

describe('TodoList（T-111 清单渲染）', () => {
  afterAll(() => {
    cleanup();
  });

  test('countStatuses：按状态统计', () => {
    expect(countStatuses(ITEMS)).toEqual({
      pending: 1,
      in_progress: 1,
      done: 1,
    });
    expect(countStatuses([])).toEqual({ pending: 0, in_progress: 0, done: 0 });
    // 缺省 status 按 pending 计
    expect(countStatuses([{ text: 'x' }])).toEqual({
      pending: 1,
      in_progress: 0,
      done: 0,
    });
  });

  test('formatTodoBar：进度条按 done 占比填充', () => {
    const bar = formatTodoBar(ITEMS);
    // 1/3 done → 约 33% 填充，百分比 33%（四舍五入）
    expect(bar).toContain('%');
    expect(bar).toContain('(1/3)');
    expect(bar).toContain('█'.repeat(Math.round((1 / 3) * TODO_BAR_WIDTH)));
    expect(bar).toContain('░');
    expect(formatTodoBar([])).toContain('(0/0)');
  });

  test('formatTodoRows：勾选标记 + 序号 + 依赖提示', () => {
    const rows = formatTodoRows(ITEMS);
    expect(rows).toEqual([
      '[x] 1. 读取项目结构',
      '[~] 2. 实现 TodoWrite  [依赖: a]',
      '[ ] 3. 写测试',
    ]);
  });

  test('渲染：标题 + 进度条 + 每条目一行（勾选 / 进行中 / 待办）', () => {
    const { lastFrame, unmount } = render(<TodoList items={ITEMS} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('待办清单');
    expect(frame).toContain('1/3');
    expect(frame).toContain('[x] 1. 读取项目结构');
    expect(frame).toContain('[~] 2. 实现 TodoWrite');
    expect(frame).toContain('[ ] 3. 写测试');
    unmount();
  });

  test('空清单不渲染内容', () => {
    const { lastFrame, unmount } = render(<TodoList items={[]} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('待办清单');
    unmount();
  });
});
