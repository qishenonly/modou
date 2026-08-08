import { describe, expect, test } from 'bun:test';
import type { ProtocolEvent } from '../../protocol/events';
import { runToolPipeline } from '../pipeline';
import { ToolRegistry } from '../registry';
import type { ToolContext, ToolOutcome, TodoUpdate } from '../types';
import {
  createTodoTool,
  TODO_MAX_ITEMS,
  todoWriteSchema,
  todoTool,
} from './todo';

/** 捕获 onTodoUpdate 上报的清单更新（测试替身）。 */
function captureUpdates(): {
  updates: TodoUpdate[];
  context: ToolContext;
} {
  const updates: TodoUpdate[] = [];
  return {
    updates,
    context: {
      signal: new AbortController().signal,
      onTodoUpdate: (update) => {
        updates.push(update);
      },
    },
  };
}

/** 经管线执行一次 todo_write（返回 outcome + 捕获的协议事件）。 */
async function runTodo(
  input: unknown,
  context: ToolContext,
): Promise<{ outcome: ToolOutcome; events: ProtocolEvent[] }> {
  const registry = new ToolRegistry().register(todoTool);
  const events: ProtocolEvent[] = [];
  const outcome = await runToolPipeline(
    { id: 't1', name: 'todo_write', input },
    {
      registry,
      context,
      emit: (event) => {
        events.push(event);
      },
    },
  );
  return { outcome, events };
}

describe('TodoWrite 工具（T-110）', () => {
  test('工具契约：名称 / 描述 / schema / 风险 read（无文件副作用）', () => {
    expect(todoTool.name).toBe('todo_write');
    expect(todoTool.risk).toBe('read'); // 见 todo.ts 文件头风险决策注释
    expect(todoTool.description.length).toBeGreaterThan(0);
    expect(todoWriteSchema.safeParse({ list: [] }).success).toBe(true);
  });

  test('schema 校验：缺 status / 空 text / 非法状态被拒', () => {
    // 缺 status → 拒绝
    expect(
      todoWriteSchema.safeParse({
        list: [{ text: '任务' }],
      }).success,
    ).toBe(false);
    // 空 text → 拒绝
    expect(
      todoWriteSchema.safeParse({
        list: [{ text: '', status: 'pending' }],
      }).success,
    ).toBe(false);
    // 非法状态 → 拒绝
    expect(
      todoWriteSchema.safeParse({
        list: [{ text: '任务', status: 'blocked' }],
      }).success,
    ).toBe(false);
    // 超上限 → 拒绝
    const huge = Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, i) => ({
      id: `t${i}`,
      text: `任务 ${i}`,
      status: 'pending' as const,
    }));
    expect(todoWriteSchema.safeParse({ list: huge }).success).toBe(false);
  });

  test('创建清单：上报全量条目、payload 带条目与状态计数', async () => {
    const { updates, context } = captureUpdates();
    const { outcome } = await runTodo(
      {
        list: [
          { id: 'a', text: '读取项目结构', status: 'done' },
          { id: 'b', text: '实现 TodoWrite', status: 'in_progress' },
          { text: '写测试', status: 'pending' },
        ],
      },
      context,
    );

    expect(outcome.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].items).toHaveLength(3);

    const payload = outcome.payload as {
      items: readonly unknown[];
      counts: { pending: number; in_progress: number; done: number };
    };
    expect(payload.items).toHaveLength(3);
    expect(payload.counts).toEqual({ pending: 1, in_progress: 1, done: 1 });
    // forModel 含完整清单（模型后续轮次可读当前状态）
    expect(outcome.forModel).toContain('实现 TodoWrite');
    expect(outcome.forModel).toContain('[x]');
    expect(outcome.forModel).toContain('[~]');
  });

  test('状态流转：同一 id 的条目随更新替换', async () => {
    const { updates, context } = captureUpdates();
    // 第一轮：pending
    await runTodo(
      { list: [{ id: 'a', text: '实现 TodoWrite', status: 'pending' }] },
      context,
    );
    // 第二轮：同一 id 流转为 done
    const { outcome } = await runTodo(
      { list: [{ id: 'a', text: '实现 TodoWrite', status: 'done' }] },
      context,
    );
    expect(updates).toHaveLength(2);
    expect(updates[1].items[0].status).toBe('done');
    const payload = outcome.payload as {
      counts: { pending: number; in_progress: number; done: number };
    };
    expect(payload.counts).toEqual({ pending: 0, in_progress: 0, done: 1 });
  });

  test('依赖：dependsOn 随条目透传', async () => {
    const { updates, context } = captureUpdates();
    const { outcome } = await runTodo(
      {
        list: [
          {
            id: 'b',
            text: '实现 TodoWrite',
            status: 'in_progress',
            dependsOn: ['a'],
          },
          { id: 'a', text: '读取项目结构', status: 'done' },
        ],
      },
      context,
    );
    expect(updates[0].items[0].dependsOn).toEqual(['a']);
    expect(outcome.forModel).toContain('依赖: a');
  });

  test('空清单：清空当前清单', async () => {
    const { updates, context } = captureUpdates();
    const { outcome } = await runTodo({ list: [] }, context);
    expect(outcome.ok).toBe(true);
    expect(updates[0].items).toEqual([]);
    expect(outcome.forModel).toContain('清单为空');
  });

  test('经管线：tool_call / tool_result 事件齐全，参数校验失败回可诊断错误', async () => {
    const { context } = captureUpdates();
    // 合法调用 → 成功
    const good = await runTodo(
      { list: [{ text: '任务', status: 'pending' }] },
      context,
    );
    expect(good.events.some((e) => e.type === 'tool_call')).toBe(true);
    expect(good.events.some((e) => e.type === 'tool_result')).toBe(true);

    // 非法参数（缺 status）→ ok:false 且列出正确用法
    const bad = await runTodo({ list: [{ text: '任务' }] }, context);
    expect(bad.outcome.ok).toBe(false);
    expect(bad.outcome.forModel).toContain('参数校验失败');
    expect(bad.outcome.forModel).toContain('todo_write');
  });

  test('createTodoTool 与默认实例同构', () => {
    const created = createTodoTool();
    expect(created.name).toBe(todoTool.name);
    expect(created.schema.safeParse({ list: [] }).success).toBe(true);
    expect(created.risk).toBe(todoTool.risk);
  });
});
