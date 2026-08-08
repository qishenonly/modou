/**
 * 待办清单渲染（T-111）：进度条 + 完成项勾选 + 进行中高亮。
 *
 * 数据来源是协议 `todo_update` 事件负载（loop 在模型调用 todo_write 时发出；
 * /resume 时 runTui 推合成信封回填）。本组件是纯展示——不订阅事件、不持有
 * core 内部对象（002 2.1：前端是 core 的纯消费者）。
 *
 * ## 分工
 *
 * - `countStatuses` / `formatTodoBar` / `formatTodoRows`：纯函数格式化（进度条、
 *   条目行），独立导出便于离线测试（不依赖 Ink 渲染）；
 * - `TodoList`：渲染组件。进度条一行 + 每条目一行（done 绿色勾选 / in_progress
 *   黄色进行中 / pending 灰色待办），依赖关系用 `→` 提示。
 *
 * 渲染位置：App 输出区的独立区（工具调用列表之上），清单非空才显示。
 */
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { TodoItemData } from '@modou/core';

/** 进度条宽度（字符）。 */
export const TODO_BAR_WIDTH = 20;

/** 各状态条目数统计。 */
export function countStatuses(items: readonly TodoItemData[]): {
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

/** 进度条文本：`████░░░░ 60%`（按 done 占比填充固定宽度）。 */
export function formatTodoBar(items: readonly TodoItemData[]): string {
  const { done } = countStatuses(items);
  const total = items.length;
  const ratio = total === 0 ? 0 : done / total;
  const filled = Math.round(ratio * TODO_BAR_WIDTH);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(TODO_BAR_WIDTH - filled)}`;
  const pct = `${Math.round(ratio * 100)}%`.padStart(4);
  return `${bar} ${pct} (${done}/${total})`;
}

/** 单条目的状态标记（渲染用）。 */
const STATUS_MARK = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
} as const;

/**
 * 条目行格式化（纯函数）：`[x] 1. 读取项目结构` / `[~] 2. 实现（依赖: 1）`。
 * 依赖用 `依赖: <id>` 后缀提示（id 短、直接展示）。
 */
export function formatTodoRows(items: readonly TodoItemData[]): string[] {
  return items.map((item, index) => {
    const mark = STATUS_MARK[item.status ?? 'pending'];
    const depends =
      item.dependsOn !== undefined && item.dependsOn.length > 0
        ? `  [依赖: ${item.dependsOn.join(' → ')}]`
        : '';
    return `${mark} ${index + 1}. ${item.text}${depends}`;
  });
}

/** TodoList 组件属性。 */
export interface TodoListProps {
  /** 当前清单条目（todo_update 事件负载；空数组不渲染）。 */
  readonly items: readonly TodoItemData[];
}

/** 条目行颜色：done 绿色 / in_progress 黄色 / pending 默认。 */
function itemColor(status: TodoItemData['status']): string | undefined {
  if (status === 'done') return 'green';
  if (status === 'in_progress') return 'yellow';
  return undefined;
}

/** 待办清单（T-111）：进度条 + 完成项勾选 + 进行中高亮。 */
export function TodoList(props: TodoListProps): ReactElement {
  const { items } = props;
  if (items.length === 0) return <Box />;
  const rows = formatTodoRows(items);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold color="cyan">
          待办清单
        </Text>
        <Text dimColor> {formatTodoBar(items)}</Text>
      </Box>
      {rows.map((row, index) => (
        <Text
          key={index}
          color={itemColor(items[index]?.status)}
          dimColor={items[index]?.status === 'pending'}
        >
          {row}
        </Text>
      ))}
    </Box>
  );
}
