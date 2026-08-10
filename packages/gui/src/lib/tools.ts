/**
 * 工具调用展示的数据层（从 packages/tui/src/tools.tsx 移植纯函数，去掉 Ink）。
 *
 * 渲染进程把 tool_call / tool_progress / tool_result 事件规约成按 callId 组织的
 * 条目，工具卡片组件据此渲染；Edit 结果带 old_string→new_string 时渲染成 diff
 * （删除行红 / 添加行绿）。与 TUI 同一套规约与 diff 口径，保证两个前端展示一致。
 */
import type {
  ToolCallData,
  ToolProgressData,
  ToolResultData,
} from '@modou/core';

/** 工具调用的生命周期。 */
export type ToolCallStatus = 'pending' | 'running' | 'done';

/** 一条工具调用的展示条目（按 callId 归拢三个工具事件的字段）。 */
export interface ToolCallEntry {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: ToolCallStatus;
  readonly ok?: boolean;
  readonly summary?: string;
  readonly forModel?: string;
  readonly payload?: unknown;
  readonly progress?: string;
}

/** 与工具展示相关的协议事件子集。 */
export type ToolEvent =
  | { readonly type: 'tool_call'; readonly data: ToolCallData }
  | { readonly type: 'tool_progress'; readonly data: ToolProgressData }
  | { readonly type: 'tool_result'; readonly data: ToolResultData };

const SUMMARY_MAX = 80;

function patchEntry(
  state: readonly ToolCallEntry[],
  id: string,
  patch: Partial<Omit<ToolCallEntry, 'id'>>,
): ToolCallEntry[] {
  const index = state.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return [
      ...state,
      { id, name: '工具', input: undefined, status: 'done', ...patch },
    ];
  }
  return state.map((entry, i) =>
    i === index ? { ...entry, ...patch } : entry,
  );
}

function upsertToolCall(
  state: readonly ToolCallEntry[],
  data: ToolCallData,
): ToolCallEntry[] {
  const index = state.findIndex((entry) => entry.id === data.id);
  if (index < 0) {
    return [
      ...state,
      { id: data.id, name: data.name, input: data.input, status: 'pending' },
    ];
  }
  return state.map((entry, i) =>
    i === index ? { ...entry, name: data.name, input: data.input } : entry,
  );
}

/** 把一条工具相关事件规约到条目列表（immutable）。 */
export function reduceToolEvent(
  state: readonly ToolCallEntry[],
  event: ToolEvent,
): ToolCallEntry[] {
  switch (event.type) {
    case 'tool_call':
      return upsertToolCall(state, event.data);
    case 'tool_progress':
      return patchEntry(state, event.data.id, {
        status: 'running',
        progress: event.data.text,
      });
    case 'tool_result':
      return patchEntry(state, event.data.id, {
        status: 'done',
        ok: event.data.ok,
        summary: event.data.summary,
        ...(event.data.forModel !== undefined
          ? { forModel: event.data.forModel }
          : {}),
        ...(event.data.payload !== undefined
          ? { payload: event.data.payload }
          : {}),
      });
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const KEY_ARG_KEYS = ['command', 'pattern', 'path', 'content'] as const;

/** 进行中条目的参数摘要（bash→command、Grep→pattern、Edit/Write→path…）。 */
export function summarizeInput(name: string, input: unknown): string {
  if (typeof input === 'string') return truncate(input, SUMMARY_MAX);
  if (input !== null && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of KEY_ARG_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        return truncate(value, SUMMARY_MAX);
      }
    }
  }
  return truncate(safeJson(input), SUMMARY_MAX);
}

/** 已完成的条目摘要：优先工具自报 summary，缺省取 forModel 首个非空行。 */
export function summarizeEntry(entry: ToolCallEntry): string {
  if (entry.summary !== undefined && entry.summary.length > 0) {
    return truncate(entry.summary, SUMMARY_MAX);
  }
  const firstLine = (entry.forModel ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return truncate(firstLine ?? '（无摘要）', SUMMARY_MAX);
}

// ---------------------------------------------------------------------------
// diff 计算（Edit 单处替换 → 前缀/后缀上下文 + 中间删除/添加）
// ---------------------------------------------------------------------------

export type DiffLineKind = 'context' | 'remove' | 'add' | 'header';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

function commonSuffix(
  a: readonly string[],
  b: readonly string[],
  prefix: number,
): number {
  let n = 0;
  while (
    a.length - 1 - n >= prefix &&
    b.length - 1 - n >= prefix &&
    a[a.length - 1 - n] === b[b.length - 1 - n]
  ) {
    n += 1;
  }
  return n;
}

/** 计算 old/new 文本的逐行 diff（Edit 是单处连续替换：公共前缀/后缀 + 中间删/加）。 */
export function buildDiffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const prefix = commonPrefix(oldLines, newLines);
  const suffix = commonSuffix(oldLines, newLines, prefix);

  const lines: DiffLine[] = [];
  for (const text of oldLines.slice(0, prefix)) {
    lines.push({ kind: 'context', text });
  }
  for (const text of oldLines.slice(prefix, oldLines.length - suffix)) {
    lines.push({ kind: 'remove', text });
  }
  for (const text of newLines.slice(prefix, newLines.length - suffix)) {
    lines.push({ kind: 'add', text });
  }
  for (const text of newLines.slice(newLines.length - suffix)) {
    lines.push({ kind: 'context', text });
  }
  return lines;
}

/**
 * 解析 git 输出的 unified diff 文本为 DiffLine[]：`@@` 头与 `diff`/`index`/`---`/
 * `+++`/`\`（No newline 标记）开头的元信息行标 header，`+`/`-` 行标 add/remove，
 * 其余（` ` 前缀或空行）标 context。空文本返回 []。
 */
export function parseUnifiedDiff(text: string): DiffLine[] {
  return splitLines(text).map((line): DiffLine => {
    if (line.startsWith('@@')) {
      return { kind: 'header', text: line };
    }
    if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('\\')
    ) {
      return { kind: 'header', text: line };
    }
    if (line.startsWith('+')) return { kind: 'add', text: line };
    if (line.startsWith('-')) return { kind: 'remove', text: line };
    return { kind: 'context', text: line };
  });
}

/** 从 tool_result 的 payload 中探测 diff 结构，有则返回 diff 行，没有返回 null。 */
export function diffFromPayload(payload: unknown): DiffLine[] | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  const source = record['diff'];
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    const nested = source as Record<string, unknown>;
    if (
      typeof nested['oldText'] === 'string' &&
      typeof nested['newText'] === 'string'
    ) {
      return buildDiffLines(nested['oldText'], nested['newText']);
    }
  }

  const oldText = record['old_string'];
  const newText = record['new_string'];
  if (typeof oldText === 'string' && typeof newText === 'string') {
    return buildDiffLines(oldText, newText);
  }
  return null;
}

/** 通用展示：字符串原样；对象/数组 JSON 美化；null/undefined 给占位。 */
export function formatValue(value: unknown): string {
  if (value === undefined) return '（无输出）';
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 状态标记（工具卡片标题行）。 */
export function markerOf(entry: ToolCallEntry): {
  readonly marker: string;
  readonly tone: 'ok' | 'fail' | 'run';
} {
  if (entry.status === 'done') {
    return entry.ok === true
      ? { marker: '✓', tone: 'ok' }
      : { marker: '✗', tone: 'fail' };
  }
  return { marker: '…', tone: 'run' };
}

/** 工具名 → 中文标签（卡片展示；未知工具名回退原样）。 */
const TOOL_LABEL: Readonly<Record<string, string>> = {
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  grep: '搜索内容',
  glob: '匹配文件名',
  bash: '执行命令',
};

export function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name;
}
