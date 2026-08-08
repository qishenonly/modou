/**
 * 增量压缩的持久摘要状态（design 002 §7.2，T-070）。
 *
 * 压缩状态是一个**结构化对象**，不是一段散文。设计动机（002 7.2）：
 * 全量重写摘要会导致 context collapse——每次重写都趋向更简短，领域细节
 * 逐轮流失，最后 agent 忘了自己在干什么。因此压缩时对**条目**做增删改，
 * 而不是让模型重写整个摘要：
 *
 * - `goal` 与 `filesTouched` 进硬事实白名单：前者是任务的锚（pin，永不改写），
 *   后者是客观记录（只追加、永不删除）。两者一旦丢失就无法从上下文里恢复；
 * - 其余条目（constraints / decisions / done / todo / findings /
 *   openQuestions）按 `id ?? text` 为键**合并 / 去重 / 追加**：同键新条目
 *   替换旧条目（「改」）、无键重复文本去重、新文本追加；`delta.removed`
 *   显式删除（「删」）；
 * - `merge(existing, delta)` 是纯函数：产出新状态，`rev = existing.rev + 1`，
 *   绝不修改入参（投影 / 压缩的可逆性依赖「日志原文仍在」的语义，002 4.1）。
 *
 * 依赖方向：Context 只依赖 Session（002 2.2）——`rebuildSummaryState` 从会话
 * 记录的 compaction 条目重建状态，因此 import session/log.ts 的类型；
 * log.ts 不自知本模块（compaction 条目里的 `state` 字段以 `unknown` 落盘，
 * 由本模块的 isSummaryState 做运行时结构守卫）。
 */

import type { SessionRecord } from '../session/log';

// ---------------------------------------------------------------------------
// 结构
// ---------------------------------------------------------------------------

/** 待办条目的状态（TodoWrite 复用；ADR 0010「清单与压缩状态共用结构」）。 */
export type TodoStatus = 'pending' | 'in_progress' | 'done';

/**
 * 摘要条目：`id` 是去重 / 更新的稳定键（缺省按 `text` 去重）。
 * 生产摘要由模型生成（0.7.0 可注入生成函数，测试用 stub），`ts` 可选留档。
 *
 * 0.11.0（ADR 0010）起 `status` / `dependsOn` 是 TodoWrite 清单条目的字段，
 * 直接挂在摘要条目上——清单 = 「把状态卸载到上下文之外」的最佳载体，两者本
 * 是同一件事的两面。压缩合并（merge）按 `id ?? text` 处理条目时**不感知**这两
 * 个字段（opaque 透传），因此待办的状态 / 依赖随压缩原样保留、清单不丢。
 */
export interface SummaryItem {
  readonly id?: string;
  readonly text: string;
  /** 条目产生的 epoch ms（可选，留档排序用）。 */
  readonly ts?: number;
  /** 待办状态（TodoWrite 清单条目携带；非待办条目缺省）。 */
  readonly status?: TodoStatus;
  /** 待办依赖（TodoWrite 清单条目携带：引用的其他待办 id 集合；非待办条目缺省）。 */
  readonly dependsOn?: readonly string[];
}

/** 已触文件（硬事实）：path 为键，只追加、永不删除、永不改写。 */
export interface FileNote {
  readonly path: string;
  /** 对该文件的备注（可选，如「读取过」「已修改」）。 */
  readonly note?: string;
}

/**
 * removed 的目标列表全集（含 filesTouched 以便运行时守卫拒绝——类型上它
 * 也在集合里，但 merge 对硬事实白名单永远跳过删除）。
 */
export type SummaryListName =
  | 'constraints'
  | 'decisions'
  | 'done'
  | 'todo'
  | 'findings'
  | 'openQuestions'
  | 'filesTouched';

/** 六个可合并列表的展示顺序（serializeSummary 依此输出）。 */
export const SUMMARY_LIST_NAMES: readonly SummaryListName[] = [
  'constraints',
  'decisions',
  'done',
  'todo',
  'findings',
  'openQuestions',
];

/**
 * 持久摘要状态（002 7.2 的结构化对象）。
 * `rev` 单调递增；`goal` 与 `filesTouched` 永不改写（硬事实白名单）。
 */
export interface SummaryState {
  /** 摘要版本号：每次压缩 +1（resume 据此判断压缩史）。 */
  readonly rev: number;
  /** 初始需求（pin，永不改写；merge 只在既有为空时接收 delta.goal）。 */
  readonly goal: string;
  /** 用户提过的约束。 */
  readonly constraints: readonly SummaryItem[];
  /** 已做的决定及理由。 */
  readonly decisions: readonly SummaryItem[];
  /** 已完成。 */
  readonly done: readonly SummaryItem[];
  /** 待办（0.11.0 TodoWrite 复用此结构，002 7.2 跨版本契约）。 */
  readonly todo: readonly SummaryItem[];
  /** 硬事实：触及过的文件清单，永不压缩。 */
  readonly filesTouched: readonly FileNote[];
  /** 关键发现。 */
  readonly findings: readonly SummaryItem[];
  /** 未决问题。 */
  readonly openQuestions: readonly SummaryItem[];
  /**
   * 压缩迟滞记账（T-070）：会话内累计的模型请求轮次数（跨 runAgentTurn
   * 接续，loop 每发起一轮请求 +1；仅启用压缩时推进）。不参与摘要语义
   * （serializeSummary 忽略、isEmptySummary 不判定），只供「压缩后 K 轮内
   * 不再触发」判定，随状态持久化（/resume 后不立即重复压缩）。
   */
  readonly turnCount?: number;
  /**
   * 压缩迟滞记账（T-070）：最近一次压缩发生时的 turnCount。
   * loop 据此做迟滞判定（`turnCount - lastCompactedTurn >= K` 才再次触发）；
   * merge 只保留不修改，由 loop / /compact 路径在压缩发生后回写。
   */
  readonly lastCompactedTurn?: number;
}

/** 一次压缩的增量（合并进既有状态；由摘要生成函数产出，测试注入 stub）。 */
export interface SummaryDelta {
  /** 新目标：仅当既有 goal 为空时生效（goal 永不改写）。 */
  readonly goal?: string;
  readonly constraints?: readonly SummaryItem[];
  readonly decisions?: readonly SummaryItem[];
  readonly done?: readonly SummaryItem[];
  readonly todo?: readonly SummaryItem[];
  readonly findings?: readonly SummaryItem[];
  readonly openQuestions?: readonly SummaryItem[];
  /** 追加的已触文件（按 path 去重；永不删除 / 永不改写）。 */
  readonly filesTouched?: readonly FileNote[];
  /**
   * 显式删除（「删」语义）：从对应列表移除键为 `key` 的条目
   * （`key` = `id ?? text`，与合并去重键一致）。filesTouched 不可删除。
   */
  readonly removed?: readonly {
    readonly list: SummaryListName;
    readonly key: string;
  }[];
}

// ---------------------------------------------------------------------------
// 构造与守卫
// ---------------------------------------------------------------------------

/** 新建空状态（rev 0，无 goal，所有列表为空）。 */
export function createSummaryState(): SummaryState {
  return {
    rev: 0,
    goal: '',
    constraints: [],
    decisions: [],
    done: [],
    todo: [],
    filesTouched: [],
    findings: [],
    openQuestions: [],
  };
}

/** 是否「空摘要」：rev 0 且 goal 与所有列表都为空（投影据此决定是否折叠）。 */
export function isEmptySummary(state: SummaryState): boolean {
  return (
    state.rev === 0 &&
    state.goal.length === 0 &&
    state.constraints.length === 0 &&
    state.decisions.length === 0 &&
    state.done.length === 0 &&
    state.todo.length === 0 &&
    state.filesTouched.length === 0 &&
    state.findings.length === 0 &&
    state.openQuestions.length === 0
  );
}

/**
 * 运行时结构守卫：一个值是否是合法的 SummaryState（浅校验各字段形态）。
 * 用于从会话日志 compaction 条目的 `state`（落盘为 unknown）重建状态。
 */
export function isSummaryState(value: unknown): value is SummaryState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.rev !== 'number') return false;
  if (typeof candidate.goal !== 'string') return false;
  if (!Array.isArray(candidate.constraints)) return false;
  if (!Array.isArray(candidate.decisions)) return false;
  if (!Array.isArray(candidate.done)) return false;
  if (!Array.isArray(candidate.todo)) return false;
  if (!Array.isArray(candidate.filesTouched)) return false;
  if (!Array.isArray(candidate.findings)) return false;
  if (!Array.isArray(candidate.openQuestions)) return false;
  // 迟滞记账字段（可选）：存在时必须是有限数字（坏日志防御）
  if (
    candidate.turnCount !== undefined &&
    (typeof candidate.turnCount !== 'number' ||
      !Number.isFinite(candidate.turnCount))
  ) {
    return false;
  }
  if (
    candidate.lastCompactedTurn !== undefined &&
    (typeof candidate.lastCompactedTurn !== 'number' ||
      !Number.isFinite(candidate.lastCompactedTurn))
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// merge：增量合并（002 7.2「压缩对条目增删改而非重写整个摘要」）
// ---------------------------------------------------------------------------

/** 条目键：id 优先，缺省按 text（去重 / 更新 / 删除的共享身份）。 */
export function itemKey(item: {
  readonly id?: string;
  readonly text: string;
}): string {
  return item.id ?? item.text;
}

/**
 * 合并一个列表：既有条目保留原序；delta 条目按 key 去重——同键**替换**
 * 为 delta 版本（「改」），无键重复文本去重（「去重」），新键**追加**（「增」）。
 * 返回新数组，不修改入参。
 *
 * 0.11.0（ADR 0010）：`status` / `dependsOn` 对合并是 opaque 字段——同键替换时
 * delta 缺失的 opaque 字段保留既有值（`mergeOpaqueFields`），待办的状态 / 依赖
 * 随压缩原样保留、清单不丢；delta 显式给出时以 delta 为准（模型能推进状态）。
 */
function mergeItems(
  existing: readonly SummaryItem[],
  delta: readonly SummaryItem[],
): SummaryItem[] {
  const result = [...existing];
  const index = new Map<string, number>();
  for (let i = 0; i < result.length; i += 1) index.set(itemKey(result[i]), i);
  for (const item of delta) {
    const key = itemKey(item);
    const hit = index.get(key);
    if (hit === undefined) {
      index.set(key, result.length);
      result.push(item);
    } else {
      result[hit] = mergeOpaqueFields(result[hit], item); // 同键新条目替换旧条目（最新理解为准）
    }
  }
  return result;
}

/**
 * 合并 opaque 字段（ADR 0010）：`status` / `dependsOn` 对压缩合并透明——delta
 * 缺失时保留既有值，显式给出时以 delta 为准。非待办列表不受影响（字段本就缺省）。
 * 返回新对象，不修改入参。
 */
function mergeOpaqueFields(
  existing: SummaryItem,
  incoming: SummaryItem,
): SummaryItem {
  return {
    ...incoming,
    ...(incoming.status === undefined && existing.status !== undefined
      ? { status: existing.status }
      : {}),
    ...(incoming.dependsOn === undefined && existing.dependsOn !== undefined
      ? { dependsOn: existing.dependsOn }
      : {}),
  };
}

/**
 * 合并文件清单（硬事实）：只追加、按 path 去重；同 path 保留既有（永不改写）。
 * 返回新数组，不修改入参。
 */
function mergeFileNotes(
  existing: readonly FileNote[],
  delta: readonly FileNote[],
): FileNote[] {
  const result = [...existing];
  const seen = new Set<string>();
  for (const note of existing) seen.add(note.path);
  for (const note of delta) {
    if (seen.has(note.path)) continue;
    seen.add(note.path);
    result.push(note);
  }
  return result;
}

/**
 * 增量合并：把新增摘要（delta）**合并进**既有状态，产出新状态（rev+1）。
 *
 * 语义（002 7.2）：
 * - `goal`：既有非空则永不改写；既有为空且 delta 提供 goal 时接收；
 * - `filesTouched`：只追加、按 path 去重、永不删除（removed 忽略该列表）；
 * - 其余六个列表：mergeItems 的合并 / 去重 / 追加；
 * - `removed`：合并完成后按 key 删除对应条目（filesTouched 除外）。
 *
 * 纯函数：不修改 existing / delta 的任何数组或对象。
 */
export function merge(
  existing: SummaryState,
  delta: SummaryDelta,
): SummaryState {
  const result: SummaryState = {
    rev: existing.rev + 1,
    goal:
      existing.goal.length > 0 ? existing.goal : (delta.goal ?? existing.goal),
    constraints: mergeItems(existing.constraints, delta.constraints ?? []),
    decisions: mergeItems(existing.decisions, delta.decisions ?? []),
    done: mergeItems(existing.done, delta.done ?? []),
    todo: mergeItems(existing.todo, delta.todo ?? []),
    filesTouched: mergeFileNotes(
      existing.filesTouched,
      delta.filesTouched ?? [],
    ),
    findings: mergeItems(existing.findings, delta.findings ?? []),
    openQuestions: mergeItems(
      existing.openQuestions,
      delta.openQuestions ?? [],
    ),
    // 迟滞记账（T-070）：只保留不修改——由 loop / /compact 路径在压缩发生后回写
    lastCompactedTurn: existing.lastCompactedTurn,
    turnCount: existing.turnCount,
  };

  for (const removal of delta.removed ?? []) {
    if (removal.list === 'filesTouched') continue; // 硬事实白名单：不可删
    const target = result[removal.list] as readonly SummaryItem[];
    (result as unknown as Record<string, unknown>)[removal.list] =
      target.filter((item) => itemKey(item) !== removal.key);
  }
  return result;
}

// ---------------------------------------------------------------------------
// resume 重建：从会话日志 compaction 条目恢复状态
// ---------------------------------------------------------------------------

/**
 * 从会话记录重建持久摘要状态（002 4.1「/resume：重放日志重建状态」）。
 *
 * 取**最后一条** compaction 条目（最新压缩史），其 `data.state` 若为合法
 * SummaryState 则原样返回；没有任何 compaction 条目或状态非法时返回
 * `undefined`（调用方据此从空状态开始）。
 *
 * 日志原文仍在（compaction 条目只记录「何时压缩了哪几轮 + 摘要快照」，
 * 002 4.2：日志永远不被裁剪）；此重建让 /resume 后能继续增量压缩，无需
 * 重新处理全量历史。
 */
export function rebuildSummaryState(
  records: readonly SessionRecord[],
): SummaryState | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.kind !== 'compaction') continue;
    if (isSummaryState(record.data.state)) return record.data.state;
  }
  return undefined;
}
