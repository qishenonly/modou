/**
 * 工具调用展示（T-043）：折叠/展开，Edit 以 diff 高亮呈现。
 *
 * ## 分工
 *
 * - `reduceToolEvent`：把 tool_call / tool_progress / tool_result 事件规约成
 *   按 callId 组织的条目列表（纯函数，不依赖 React，可单元测试）；
 * - `ToolCallList`：渲染全部工具调用。每条默认折叠为一行
 *   （`✓/✗ 工具名 摘要`），展开显示完整参数与输出；Edit 结果带
 *   old_string→new_string 时渲染成 diff（删除行红 / 添加行绿，见 DiffView）；
 * - `buildDiffLines` / `diffFromPayload`：diff 计算与「payload 是否含 diff 结构」
 *   的判定，独立导出便于测试。
 *
 * ## 折叠/展开交互（键盘）
 *
 * Ink v5 的 useInput 对每个按键会**通知所有**已注册 handler（无短路语义），
 * 而输入框（input.tsx）始终处于接收文本状态。因此工具列表只响应「输入框必然
 * 忽略」的组合键，避免打字时误触发：
 *
 * - `Ctrl+N` / `Ctrl+P`：在工具条目间移动选中（emacs 惯例；input 的 ctrl 分支
 *   只消费 a/e/d/z/y，n/p 直接忽略，不会打进输入文本）；
 * - `Ctrl+O`：展开 / 折叠选中的条目（O = open）。
 *
 * 选中项反显；列表底部有一行提示。默认全部折叠（任务要求「每条工具调用默认
 * 折叠为一行」），用户按 Ctrl+O 逐条展开查看参数与 diff。
 *
 * ## 输出渲染顺序
 *
 * 展开后的「输出」区优先级：payload 是 diff 结构 → DiffView；否则有 forModel →
 * 纯文本；否则有 payload → JSON 美化；再否则按状态给占位。参数区始终显示
 * 工具的调用入参（入参已由管线脱敏）。
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Box, Text } from 'ink';
import type {
  ToolCallData,
  ToolProgressData,
  ToolResultData,
} from '@modou/core';

// ---------------------------------------------------------------------------
// 条目模型与事件规约（纯函数，可直接单元测试）
// ---------------------------------------------------------------------------

/** 工具调用的生命周期：已请求（tool_call）→ 执行中（tool_progress）→ 完成（tool_result）。 */
export type ToolCallStatus = 'pending' | 'running' | 'done';

/** 一条工具调用的展示条目（按 callId 归拢三个工具事件的字段）。 */
export interface ToolCallEntry {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: ToolCallStatus;
  /** 成功 / 失败（tool_result.ok）。 */
  readonly ok?: boolean;
  /** 给人看的结果摘要（tool_result.summary）。 */
  readonly summary?: string;
  /** 回喂模型的文本（tool_result.forModel）。 */
  readonly forModel?: string;
  /** 结构化载荷（tool_result.payload，如 Edit 的 diff / Bash 输出）。 */
  readonly payload?: unknown;
  /** 进度文本（tool_progress.text，长命令活性反馈）。 */
  readonly progress?: string;
}

/** 与工具展示相关的协议事件子集（T-043 消费三种事件）。 */
export type ToolEvent =
  | { readonly type: 'tool_call'; readonly data: ToolCallData }
  | { readonly type: 'tool_progress'; readonly data: ToolProgressData }
  | { readonly type: 'tool_result'; readonly data: ToolResultData };

/** 折叠行展示文本的截断长度。 */
const SUMMARY_MAX = 80;

/** 按 callId 更新条目：已存在则合并 patch，不存在则兜底追加（防御 tool_result 先到）。 */
function patchEntry(
  state: readonly ToolCallEntry[],
  id: string,
  patch: Partial<Omit<ToolCallEntry, 'id'>>,
): ToolCallEntry[] {
  const index = state.findIndex((entry) => entry.id === id);
  if (index < 0) {
    // 兜底：tool_result / tool_progress 先于 tool_call 到达（正常流程不会发生，
    // 管线总是先发 tool_call）。此时工具名不可知，用通用名占位。
    return [
      ...state,
      { id, name: '工具', input: undefined, status: 'done', ...patch },
    ];
  }
  return state.map((entry, i) =>
    i === index ? { ...entry, ...patch } : entry,
  );
}

/** 新建或刷新 tool_call 条目（重复 tool_call 保留已填充的结果字段，只刷参数）。 */
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

/**
 * 把一条工具相关事件规约到条目列表（immutable）。
 * - tool_call：创建条目（pending）；
 * - tool_progress：标记 running 并记录进度文本；
 * - tool_result：标记 done 并填充成功/失败、摘要、forModel、payload。
 */
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

// ---------------------------------------------------------------------------
// 摘要（折叠行：`✓/✗ 工具名 摘要`）
// ---------------------------------------------------------------------------

/** 截断文本到 max 字符（尾部加省略号）。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 兜底 JSON 序列化（循环引用等异常时退化为 String）。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 折叠行优先展示的关键参数键（按顺序取第一个字符串值）。 */
const KEY_ARG_KEYS = ['command', 'pattern', 'path', 'content'] as const;

/**
 * 进行中条目的参数摘要：取工具调用的关键参数（bash→command、Grep→pattern、
 * Edit/Write→path…），缺省退化为紧凑 JSON。
 */
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

/**
 * 已完成的条目摘要：优先工具自报的 summary（协议总是带上），缺省取 forModel
 * 首个非空行（与 core 管线 deriveSummary 同策略）。
 */
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

/** diff 行种类：上下文 / 删除 / 添加。 */
export type DiffLineKind = 'context' | 'remove' | 'add';

/** 一行 diff：种类 + 文本。 */
export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

/** 按 `\n` 切行，剥掉末尾换行带来的多余空串（`'a\n'` → `['a']`）。 */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 两数组的公共前缀长度。 */
function commonPrefix(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/** 两数组在 prefix 之后区域的公共后缀长度（保证与前缀不重叠）。 */
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

/**
 * 计算 old/new 文本的逐行 diff。
 *
 * Edit 是**单处连续替换**：old_string → new_string。因此公共前缀行与公共后缀行
 * 保持不变（context），中间的旧行是删除、新行是添加——O(行数) 即可精确呈现，
 * 无需 LCS。未来若出现非连续替换的 diff（如 apply_patch 的多个 hunk），再换成
 * 通用 diff 算法；当前语义下前缀/后缀法正确且简单。
 */
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
 * 从 tool_result 的 payload 中探测 diff 结构，有则返回 diff 行，没有返回 null。
 *
 * 支持的形状（「old_string→new_string 或类似」，T-043）：
 * - Edit 成功 payload：`{ old_string, new_string }`（core 侧按 EDIT_PAYLOAD_DIFF_MAX
 *   截断，防事件流膨胀）；
 * - 通用嵌套形状：`{ diff: { oldText, newText } }`（前端按形状探测、不按工具名
 *   耦合，符合 002 3.2「前端不该解析给模型的纯文本」的分层）。
 *
 * 其余 payload（Bash 的 stdout/stderr、Write 的文件列表…）一律返回 null，交给
 * 文本展示。
 */
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

// ---------------------------------------------------------------------------
// 通用文本展示（非 diff 输出）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 渲染组件
// ---------------------------------------------------------------------------

/** diff 行渲染：删除行红色（- 前缀）、添加行绿色（+ 前缀）、上下文默认色。 */
export function DiffView({
  lines,
}: {
  readonly lines: readonly DiffLine[];
}): ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.map((line, index) => (
        <Text
          key={index}
          color={
            line.kind === 'remove'
              ? 'red'
              : line.kind === 'add'
                ? 'green'
                : undefined
          }
          dimColor={line.kind === 'context'}
        >
          {line.kind === 'remove' ? '-' : line.kind === 'add' ? '+' : ' '}{' '}
          {line.text}
        </Text>
      ))}
    </Box>
  );
}

/** 状态标记：完成 → ✓/✗（绿/红）；进行中 → …（黄）。 */
function markerOf(entry: ToolCallEntry): {
  readonly marker: string;
  readonly color?: string;
} {
  if (entry.status === 'done') {
    return entry.ok === true
      ? { marker: '✓', color: 'green' }
      : { marker: '✗', color: 'red' };
  }
  return { marker: '…', color: 'yellow' };
}

/** 旋转动画帧（进行中工具调用的「闪烁」指示；Ink Text 无 blink 属性，用动画替代）。 */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** 工具调用单行状态（Claude Code 式紧凑展示）：只看最新一条，进行中旋转闪烁。 */
export function ToolCallList({
  entries,
}: {
  readonly entries: readonly ToolCallEntry[];
}): ReactElement {
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const active = last?.status === 'pending' || last?.status === 'running';
  const [spinner, setSpinner] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => setSpinner((prev) => (prev + 1) % SPINNER.length),
      100,
    );
    return () => clearInterval(timer);
  }, [active]);

  if (last === undefined) return <Box />;
  const { marker, color } = markerOf(last);
  const summary =
    last.status === 'done'
      ? summarizeEntry(last)
      : summarizeInput(last.name, last.input);
  const indicator = active ? SPINNER[spinner % SPINNER.length] : marker;
  return (
    <Box>
      <Text color={color}>
        {indicator} {last.name}
      </Text>
      <Text dimColor> {summary}</Text>
    </Box>
  );
}
