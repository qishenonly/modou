import { describe, expect, test } from 'bun:test';
import type { SessionRecord } from '../session/log';
import { createSummaryState, merge } from './summary';
import {
  applyTodoWrite,
  countTodoStatuses,
  createTodoState,
  rebuildTodoState,
} from './todo';

describe('TodoState（T-110 会话级待办清单）', () => {
  test('createTodoState 初始为空', () => {
    expect(createTodoState().items).toEqual([]);
  });

  test('applyTodoWrite：全量清单为准（创建 / 更新 / 顺序 / 去重）', () => {
    const state = createTodoState();
    // 创建：三条条目
    const first = applyTodoWrite(state, [
      { id: 'a', text: '读取项目结构', status: 'done' },
      { id: 'b', text: '实现 TodoWrite', status: 'in_progress' },
      { text: '写测试', status: 'pending' },
    ]);
    expect(first.items).toHaveLength(3);
    expect(first.items.map((i) => i.id)).toEqual(['a', 'b', undefined]);

    // 更新 + 保序：b 流转为 done，a 提前，新增 c
    const second = applyTodoWrite(first, [
      { id: 'b', text: '实现 TodoWrite', status: 'done' },
      { id: 'a', text: '读取项目结构', status: 'done' },
      { id: 'c', text: '跑四门验证', status: 'pending' },
    ]);
    expect(second.items).toHaveLength(3);
    expect(second.items.map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(second.items[0].status).toBe('done');

    // 清空
    expect(applyTodoWrite(second, []).items).toEqual([]);
  });

  test('applyTodoWrite：同键去重保留末次（id 优先，缺省按 text）', () => {
    const state = applyTodoWrite(createTodoState(), [
      { id: 'x', text: '旧文本', status: 'pending' },
      { id: 'x', text: '新文本', status: 'done' },
      { text: '无 id 任务', status: 'pending' },
      { text: '无 id 任务', status: 'done' },
    ]);
    expect(state.items).toHaveLength(2);
    expect(state.items[0].text).toBe('新文本');
    expect(state.items[0].status).toBe('done');
    expect(state.items[1].status).toBe('done');
  });

  test('countTodoStatuses：按状态统计（缺省计 pending）', () => {
    const state = applyTodoWrite(createTodoState(), [
      { text: 'a', status: 'pending' },
      { text: 'b', status: 'in_progress' },
      { text: 'c', status: 'done' },
      { text: 'd', status: 'done' },
      { text: 'e' }, // 缺省 status 按 pending 计
    ]);
    expect(countTodoStatuses(state.items)).toEqual({
      pending: 2,
      in_progress: 1,
      done: 2,
    });
  });

  test('applyTodoWrite 纯函数：不修改入参', () => {
    const state = createTodoState();
    const items = [{ id: 'a', text: '任务', status: 'pending' as const }];
    const next = applyTodoWrite(state, items);
    expect(next).not.toBe(state);
    expect(state.items).toEqual([]);
    expect(items[0].status).toBe('pending');
  });

  test('rebuildTodoState：从会话日志最后一条 todo_update 重建清单', () => {
    const records: SessionRecord[] = [
      { seq: 1, ts: 1, kind: 'user', data: { text: '开始' } },
      {
        seq: 2,
        ts: 2,
        kind: 'todo_update',
        data: {
          items: [
            { id: 'a', text: '读取', status: 'done' },
            { id: 'b', text: '实现', status: 'in_progress', dependsOn: ['a'] },
          ],
        },
      },
      { seq: 3, ts: 3, kind: 'user', data: { text: '继续' } },
      {
        seq: 4,
        ts: 4,
        kind: 'todo_update',
        data: {
          items: [{ id: 'b', text: '实现', status: 'done' }],
        },
      },
    ];
    const rebuilt = rebuildTodoState(records);
    expect(rebuilt).toBeDefined();
    expect(rebuilt!.items).toHaveLength(1);
    expect(rebuilt!.items[0].id).toBe('b');
    expect(rebuilt!.items[0].status).toBe('done');
  });

  test('rebuildTodoState：无 todo_update 返回 undefined；坏数据跳过', () => {
    expect(
      rebuildTodoState([{ seq: 1, ts: 1, kind: 'user', data: { text: 'hi' } }]),
    ).toBeUndefined();
    // 坏条目（缺 text / 非法 status）被过滤，合法条目保留
    const rebuilt = rebuildTodoState([
      {
        seq: 1,
        ts: 1,
        kind: 'todo_update',
        data: {
          items: [
            { text: '', status: 'pending' },
            { text: '合法', status: 'blocked' },
            { text: '保留', status: 'done' },
          ],
        },
      } as unknown as SessionRecord,
    ]);
    // 坏数据宽容：缺 text 的条目丢弃；非法 status 的条目保留但状态回落
    // （undefined = pending，与 delta.ts normalizeItems 的坏值丢弃语义一致）
    expect(rebuilt).toBeDefined();
    expect(rebuilt!.items).toHaveLength(2);
    expect(rebuilt!.items[0].text).toBe('合法');
    expect(rebuilt!.items[0].status).toBeUndefined();
    expect(rebuilt!.items[1].text).toBe('保留');
    expect(rebuilt!.items[1].status).toBe('done');
  });

  // ---------------------------------------------------------------------------
  // ADR 0010：清单与压缩状态共用结构，压缩时清单不丢
  // ---------------------------------------------------------------------------

  test('合并兼容：TodoWrite 条目（含 status/dependsOn）经 merge 进 SummaryState.todo 不丢', () => {
    const state = createSummaryState();
    // TodoWrite 产出的条目作为压缩增量里的 todo 列表
    const delta = {
      todo: [
        { id: 'a', text: '读取', status: 'done' as const },
        {
          id: 'b',
          text: '实现',
          status: 'in_progress' as const,
          dependsOn: ['a'],
        },
      ],
    };
    const merged = merge(state, delta);
    expect(merged.todo).toHaveLength(2);
    // 状态 / 依赖随压缩原样保留（merge 按 id/text 处理条目，opaque 透传）
    const itemB = merged.todo.find((item) => item.id === 'b');
    expect(itemB).toBeDefined();
    expect(itemB!.status).toBe('in_progress');
    expect(itemB!.dependsOn).toEqual(['a']);
  });

  test('合并兼容：同 id 更新（改）覆盖旧状态，TodoWrite 清单流转在摘要侧成立', () => {
    const state = merge(createSummaryState(), {
      todo: [{ id: 'b', text: '实现', status: 'pending' }],
    });
    const merged = merge(state, {
      todo: [{ id: 'b', text: '实现', status: 'done' }],
    });
    expect(merged.todo).toHaveLength(1);
    expect(merged.todo[0].status).toBe('done');
  });

  test('合并兼容：TodoState → 摘要 delta 往返（applyTodoWrite 产物可作 delta 合并）', () => {
    const todoState = applyTodoWrite(createTodoState(), [
      { id: 'a', text: '读取', status: 'done' },
      { id: 'b', text: '实现', status: 'in_progress', dependsOn: ['a'] },
    ]);
    const summary = merge(createSummaryState(), { todo: todoState.items });
    expect(summary.todo).toHaveLength(2);
    const rebuilt = rebuildTodoState([
      { seq: 1, ts: 1, kind: 'todo_update', data: { items: summary.todo } },
    ]);
    expect(rebuilt!.items.map((i) => i.status)).toEqual([
      'done',
      'in_progress',
    ]);
    expect(rebuilt!.items[1].dependsOn).toEqual(['a']);
  });
});
