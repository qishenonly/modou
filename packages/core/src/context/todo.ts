/**
 * 会话级待办清单状态（T-110 TodoWrite / 0.11.0「会规划」）。
 *
 * TodoWrite 工具（tools/impl/todo.ts）让模型自主维护任务清单（状态 / 顺序 /
 * 依赖）。清单是**结构化状态**，存在于上下文之外，可在内存 / 日志间往返：
 *
 * - `TodoState`：当前清单的权威形态（`items` 复用 SummaryState.todo 的条目
 *   结构 SummaryItem——ADR 0010：清单与压缩状态共用结构，压缩时清单不丢）；
 * - `applyTodoWrite(state, items)`：把一次 TodoWrite 的清单快照并入当前状态。
 *   TodoWrite 发送的是**全量期望清单**（模型每次带全部条目，Claude Code 同款），
 *   因此语义是「以本次清单为准」：按 `id ?? text` 去重（同键保留末次）、整体
 *   替换列表（模型负责维护顺序与依赖）；
 * - `rebuildTodoState(records)`：从会话日志的 `todo_update` 条目重建清单
 *   （002 4.1「日志是唯一真相」——TodoWrite 每次更新都落一条快照，resume 后
 *   清单仍在，无需重放全量历史）。
 *
 * 依赖方向：本模块只依赖 Session（session/log.ts 的类型）与 summary.ts 的
 * 结构——与 SummaryState 共用条目结构，但不感知 runtime / tools。
 */
import type { SessionRecord } from '../session/log';
import { itemKey, type SummaryItem, type TodoStatus } from './summary';

/** 会话级待办清单状态。 */
export interface TodoState {
  /** 当前清单条目（复用 SummaryState.todo 的 SummaryItem 结构，ADR 0010）。 */
  readonly items: readonly SummaryItem[];
}

/** 新建空清单（无任何条目）。 */
export function createTodoState(): TodoState {
  return { items: [] };
}

/** 按状态统计条目数（进度条 / 状态栏用）。 */
export function countTodoStatuses(items: readonly SummaryItem[]): {
  readonly pending: number;
  readonly in_progress: number;
  readonly done: number;
} {
  let pending = 0;
  let in_progress = 0;
  let done = 0;
  for (const item of items) {
    switch (item.status) {
      case 'in_progress':
        in_progress += 1;
        break;
      case 'done':
        done += 1;
        break;
      default:
        pending += 1;
        break;
    }
  }
  return { pending, in_progress, done };
}

/**
 * 把一次 TodoWrite 的清单快照并入当前状态。
 *
 * TodoWrite 发送全量期望清单，语义 = 「以本次清单为准」：按 `id ?? text` 去重
 * （同键保留末次出现），整体替换列表（条目顺序 / 依赖由模型维护）。纯函数：
 * 不修改入参，返回新状态。
 */
export function applyTodoWrite(
  state: TodoState,
  items: readonly SummaryItem[],
): TodoState {
  const result: SummaryItem[] = [];
  const index = new Map<string, number>();
  for (const item of items) {
    const key = itemKey(item);
    const hit = index.get(key);
    if (hit === undefined) {
      index.set(key, result.length);
      result.push(item);
    } else {
      result[hit] = item;
    }
  }
  return { items: result };
}

/**
 * 从会话日志重建待办清单：取**最后一条** `todo_update` 条目（最新清单快照）。
 * 没有任何 todo_update 条目时返回 undefined（调用方从空清单开始）。
 * 条目结构浅校验（id/text/status/dependsOn 形态），坏数据跳过。
 */
export function rebuildTodoState(
  records: readonly SessionRecord[],
): TodoState | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.kind !== 'todo_update') continue;
    const items = record.data.items;
    if (!Array.isArray(items)) continue;
    const normalized: SummaryItem[] = [];
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.text !== 'string' || candidate.text.length === 0) {
        continue;
      }
      const id =
        typeof candidate.id === 'string' && candidate.id.length > 0
          ? candidate.id
          : undefined;
      const status = isTodoStatus(candidate.status)
        ? candidate.status
        : undefined;
      const dependsOn =
        Array.isArray(candidate.dependsOn) &&
        candidate.dependsOn.every((dep) => typeof dep === 'string')
          ? [...candidate.dependsOn]
          : undefined;
      normalized.push({
        text: candidate.text,
        ...(id !== undefined ? { id } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(dependsOn !== undefined ? { dependsOn } : {}),
      });
    }
    return { items: normalized };
  }
  return undefined;
}

/** 运行时结构守卫：值是否为合法 TodoStatus。 */
function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'done';
}
