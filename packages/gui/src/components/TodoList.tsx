/**
 * 待办清单（0.11.0 T-110）：Claude 式任务清单——进度条 + 勾选 + 进行中高亮。
 * 数据来自 todo_update 事件（loop 在模型调用 todo_write 时发出全量快照）。
 */
import type { ReactNode } from 'react';
import type { TodoItemData } from '@modou/core';

function countStatuses(items: readonly TodoItemData[]): {
  readonly pending: number;
  readonly in_progress: number;
  readonly done: number;
} {
  let pending = 0;
  let in_progress = 0;
  let done = 0;
  for (const item of items) {
    if (item.status === 'in_progress') in_progress += 1;
    else if (item.status === 'done') done += 1;
    else pending += 1;
  }
  return { pending, in_progress, done };
}

/** 进度百分比（done / total）。 */
function progressOf(items: readonly TodoItemData[]): number {
  if (items.length === 0) return 0;
  return countStatuses(items).done / items.length;
}

export function TodoList({
  items,
}: {
  readonly items: readonly TodoItemData[];
}): ReactNode {
  if (items.length === 0) return null;
  const { done } = countStatuses(items);
  const progress = progressOf(items);

  return (
    <div className="todo-list">
      <div className="todo-bar-row">
        <span className="todo-label">任务清单</span>
        <span className="todo-count">
          {done}/{items.length} · {Math.round(progress * 100)}%
        </span>
      </div>
      <div className="todo-bar">
        <div
          className="todo-bar-fill"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <ul className="todo-items">
        {items.map((item, index) => {
          const status = item.status ?? 'pending';
          return (
            <li
              key={item.id ?? index}
              className={`todo-item todo-${status}`}
              title={
                status === 'pending'
                  ? '待办'
                  : status === 'done'
                    ? '已完成'
                    : '进行中'
              }
            >
              <span className="todo-check" aria-hidden="true">
                {status === 'done' ? (
                  <svg
                    viewBox="0 0 16 16"
                    className="todo-check-icon"
                    aria-hidden="true"
                  >
                    <path
                      d="M3.5 8.5 6.6 11.5l5.9-7"
                      stroke="currentColor"
                      strokeWidth="2"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : status === 'in_progress' ? (
                  <span className="todo-dot" />
                ) : null}
              </span>
              <span className="todo-text">{item.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
