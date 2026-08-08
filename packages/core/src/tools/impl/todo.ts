import { z } from 'zod';
import type { TodoWriteItem } from '../types';
import type { Tool, ToolContext, ToolOutcome } from '../types';

/**
 * TodoWrite 工具（T-110）：模型自主维护任务清单（状态 / 顺序 / 依赖）。
 *
 * 清单是**结构化状态**，存在于上下文之外（design 002 7.2 / ADR 0010）：模型
 * 每次调用带**全量期望清单**，运行时把它写入会话内结构化状态（TodoState）
 * 与日志（todo_update 条目，/resume 可重建）——清单不与对话绑定，压缩时
 * 也不丢（复用 SummaryState.todo 的条目结构，ADR 0010）。
 *
 * 风险分类决策：**`read`**。理由：
 * - 本工具的 risk 分类进 Permission 裁决（002 5.2 / 6.1 矩阵），`write` 语义是
 *   「文件系统副作用需经审批」。TodoWrite **从不触碰文件系统**——只更新会话内
 *   结构化状态（内存 + 日志旁路记录），与 Read 读文件同级的「无文件副作用」；
 * - 若标 `write`，workspace-write + on-request 缺省组合下每次更新清单都会弹
 *   审批，模型就无法「自主」维护清单——与 T-110 的目标（模型自动维护任务
 *   清单）直接矛盾；
 * - Plan Mode（T-112）的只读白名单是**按工具名**（read / grep / glob）收窄，
 *   不按 risk——TodoWrite 即使 risk 为 read 也不会进入 Plan Mode 的工具集。
 *
 * 输出治理：forModel 纯文本 = 完整清单（模型在后续轮次能读到当前状态）；
 * payload 结构化 = { items, counts }（前端渲染进度条 / 勾选，T-111）。
 */

/** 单次清单条目数上限：防止模型一次性塞入病态大列表撑爆上下文 / 日志。 */
export const TODO_MAX_ITEMS = 100;

/** TodoWrite 工具名（单一来源：注册 / 系统提示词分类 / 白名单判别复用）。 */
export const TODO_WRITE_TOOL_NAME = 'todo_write';

/** 待办状态（本地类型：与 context/summary 的 TodoStatus 同形，tools 边界内自持）。 */
type TodoStatus = 'pending' | 'in_progress' | 'done';

/** TodoWrite 清单条目 schema（zod）：id 可选 / text 必填 / status 必填 / dependsOn 可选。 */
export const todoItemSchema = z.object({
  id: z.string().min(1, 'id 不能为空字符串').optional(),
  text: z.string().min(1, 'text 不能为空字符串'),
  status: z.enum(['pending', 'in_progress', 'done'], {
    message: "status 必须是 'pending' | 'in_progress' | 'done'",
  }),
  dependsOn: z.array(z.string().min(1, '依赖 id 不能为空字符串')).optional(),
});

/** TodoWrite 工具参数 schema：list 必填（全量期望清单）。 */
export const todoWriteSchema = z.object({
  list: z
    .array(todoItemSchema)
    .max(
      TODO_MAX_ITEMS,
      `list 最多支持 ${TODO_MAX_ITEMS} 个条目，超出请合并或精简后重试`,
    ),
});

export type TodoWriteArgs = z.infer<typeof todoWriteSchema>;

/** TodoWrite 结构化载荷（成功与错误共用：错误时 error 存在）。 */
export interface TodoWritePayload {
  readonly items: readonly TodoWriteItem[];
  /** 各状态条目数（进度展示用）。 */
  readonly counts: {
    readonly pending: number;
    readonly in_progress: number;
    readonly done: number;
  };
  readonly error?: string;
}

/** 状态的中文标记（渲染 forModel 文本用）。 */
const STATUS_MARK: Readonly<Record<TodoStatus, string>> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
};

/** 渲染完整清单（forModel：让模型在后续轮次能读到当前状态）。 */
function renderTodoList(items: readonly TodoWriteItem[]): string {
  if (items.length === 0) return '（清单为空）';
  const lines = items.map((item, index) => {
    const mark = STATUS_MARK[item.status];
    const id = item.id !== undefined ? `  [id: ${item.id}]` : '';
    const depends =
      item.dependsOn !== undefined && item.dependsOn.length > 0
        ? `  [依赖: ${item.dependsOn.join(' → ')}]`
        : '';
    return `${mark} ${index + 1}. ${item.text}${id}${depends}`;
  });
  return lines.join('\n');
}

/** 统计各状态条目数。 */
function countStatuses(items: readonly TodoWriteItem[]): {
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

/**
 * 构造 TodoWrite 工具。
 * 无依赖注入选项（纯状态更新，不触碰文件系统 / 外部进程）。
 */
export function createTodoTool(): Tool<typeof todoWriteSchema> {
  return {
    name: TODO_WRITE_TOOL_NAME,
    description:
      '更新待办任务清单：模型自主维护任务的状态（pending / in_progress / done）、' +
      '顺序与依赖。参数 list 是**全量期望清单**——每次调用都带上全部条目，' +
      '运行时以本次清单为准替换当前清单（按 id 或文本去重）。' +
      '清单是持久结构化状态：跨轮次 / 跨会话（/resume）保留，上下文压缩时不丢。' +
      '用法建议：大改动前先用 todo_write 建立任务清单并标记 in_progress 的当前项；' +
      '每完成一步用 todo_write 把对应条目更新为 done 并推进进行中项。',
    schema: todoWriteSchema,
    // 见文件头注释：只更新会话内结构化状态、从不触碰文件系统，风险按 read 处理
    risk: 'read',
    execute: async (
      args: TodoWriteArgs,
      ctx: ToolContext,
    ): Promise<ToolOutcome> => {
      const items = args.list;
      // 上报运行时：写入会话结构化状态 + 日志（/resume 可重建）
      ctx.onTodoUpdate?.({ items });
      const counts = countStatuses(items);
      const forModel =
        `待办清单已更新（共 ${items.length} 项：pending ${counts.pending} / ` +
        `in_progress ${counts.in_progress} / done ${counts.done}）：\n` +
        renderTodoList(items);
      const payload: TodoWritePayload = { items, counts };
      return {
        ok: true,
        forModel,
        summary:
          `清单 ${items.length} 项（待办 ${counts.pending} / 进行中 ` +
          `${counts.in_progress} / 完成 ${counts.done}）`,
        payload,
      };
    },
  };
}

/** 默认 TodoWrite 工具实例（0.11.0 清单工具）。 */
export const todoTool: Tool<typeof todoWriteSchema> = createTodoTool();
