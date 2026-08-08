/**
 * 生产摘要增量生成（design 002 §7.2，T-070）。
 *
 * compact.ts 的 `generateDelta` 是可注入的摘要生成函数：生产由模型生成增量，
 * 测试注入 stub。本模块提供生产的默认实现：
 *
 * - `createModelDeltaGenerator(provider)`：把「旧 SummaryState + 折叠区轮次的
 *   对话文本」拼成提示词，经 provider 生成 JSON delta，解析后返回
 *   `SummaryDelta`（增量合并的输入，语义见 summary.ts）——失败时抛
 *   `SummaryDeltaError`（调用方 loop 捕获并发 notice，不崩）；
 * - `parseSummaryDelta(text)`：纯解析函数，可独立注入 stub 覆盖测试——剥
 *   markdown 围栏、容错 JSON（首个 `{` 到末个 `}` 提取重试）、字段规范化
 *   （只保留合法条目，坏条目丢弃而非整体失败）。
 *
 * 依赖方向：Context 只依赖 Session 与 Provider（002 2.2）——本模块 import
 * provider 的类型（ModelProvider），复用 budget/project 的序列化，不感知
 * runtime 内部。
 */

import type { ModelMessage } from 'ai';
import type { ModelProvider } from '../provider/types';
import {
  SUMMARY_LIST_NAMES,
  type FileNote,
  type SummaryDelta,
  type SummaryItem,
  type SummaryListName,
  type SummaryState,
} from './summary';
import { serializeMessageText } from './project';
import { serializeSummary } from './compact';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/**
 * 摘要增量生成失败（模型未产出合法 JSON / provider 错误 / 空输出）。
 * 由调用方（runtime loop / TUI /compact 路径）捕获并发 notice 降级——不崩。
 */
export class SummaryDeltaError extends Error {
  /** 底层原因（provider 抛错时保留，供诊断）。 */
  readonly cause?: unknown;

  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message);
    this.name = 'SummaryDeltaError';
    this.cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// JSON 解析（纯函数，可独立注入 stub 覆盖测试）
// ---------------------------------------------------------------------------

/**
 * 解析模型产出的摘要增量文本为 `SummaryDelta`；解析失败返回 null。
 *
 * 容错策略（模型输出不可信）：
 * 1. 剥 markdown 围栏（```json …``` / ``` … ```，含围栏外杂讯时的兜底见 3）；
 * 2. 直接 `JSON.parse`；失败时提取首个 `{` 到末个 `}` 的子串再试一次
 *    （模型常在 JSON 前后夹解释文字）；
 * 3. 字段规范化：goal 须为非空字符串；六个列表元素须含非空 text（可选 id/ts）；
 *    filesTouched 元素须含非空 path（可选 note）；removed 元素须含合法 list 与
 *    非空 key——**坏条目丢弃，合法条目保留**（宁可少一条，不让整次压缩失败）。
 */
export function parseSummaryDelta(text: string): SummaryDelta | null {
  const cleaned = stripCodeFence(text).trim();
  if (cleaned.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const object = extractJsonObject(cleaned);
    if (object === null) return null;
    try {
      parsed = JSON.parse(object);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return normalizeDelta(parsed);
}

/** 剥 markdown 围栏：```json …``` 或 ``` …``` 整体包裹时取内部文本。 */
function stripCodeFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(text);
  return match === null ? text : match[1];
}

/** 提取首个 `{` 到末个 `}` 的子串（模型在 JSON 前后夹杂讯时的兜底）。 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** 把任意值规范化为 SummaryDelta（只保留合法字段，坏条目丢弃）。 */
function normalizeDelta(value: unknown): SummaryDelta {
  const source = value as Record<string, unknown>;
  const delta: Record<string, unknown> = {};

  if (typeof source.goal === 'string' && source.goal.trim().length > 0) {
    delta.goal = source.goal.trim();
  }
  for (const name of SUMMARY_LIST_NAMES) {
    const items = normalizeItems(source[name]);
    if (items !== null && items.length > 0) {
      delta[name] = items;
    }
  }
  const files = normalizeFileNotes(source.filesTouched);
  if (files !== null && files.length > 0) delta.filesTouched = files;
  const removed = normalizeRemoved(source.removed);
  if (removed !== null && removed.length > 0) delta.removed = removed;
  return delta as SummaryDelta;
}

/** 条目数组规范化：只保留含非空 text 的条目（可选 id / ts）。 */
function normalizeItems(value: unknown): readonly SummaryItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: SummaryItem[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.text !== 'string' ||
      candidate.text.trim().length === 0
    ) {
      continue;
    }
    const text = candidate.text.trim();
    const id =
      typeof candidate.id === 'string' && candidate.id.trim().length > 0
        ? candidate.id.trim()
        : undefined;
    const ts =
      typeof candidate.ts === 'number' && Number.isFinite(candidate.ts)
        ? candidate.ts
        : undefined;
    // 0.11.0（ADR 0010）：TodoWrite 清单字段 status / dependsOn 随摘要条目
    // 透传（压缩时清单不丢）——坏值丢弃、合法值保留。
    const status =
      candidate.status === 'pending' ||
      candidate.status === 'in_progress' ||
      candidate.status === 'done'
        ? candidate.status
        : undefined;
    const dependsOn =
      Array.isArray(candidate.dependsOn) &&
      candidate.dependsOn.every((dep) => typeof dep === 'string')
        ? [...candidate.dependsOn]
        : undefined;
    items.push({
      text,
      ...(id !== undefined ? { id } : {}),
      ...(ts !== undefined ? { ts } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(dependsOn !== undefined ? { dependsOn } : {}),
    });
  }
  return items;
}

/** 文件清单规范化：只保留含非空 path 的条目（可选 note）。 */
function normalizeFileNotes(value: unknown): readonly FileNote[] | null {
  if (!Array.isArray(value)) return null;
  const notes: FileNote[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.path !== 'string' ||
      candidate.path.trim().length === 0
    ) {
      continue;
    }
    const path = candidate.path.trim();
    const note =
      typeof candidate.note === 'string' && candidate.note.trim().length > 0
        ? candidate.note.trim()
        : undefined;
    notes.push({ path, ...(note !== undefined ? { note } : {}) });
  }
  return notes;
}

/** 删除声明规范化：list 须合法且 key 非空（filesTouched 不可删，由 merge 守卫）。 */
function normalizeRemoved(
  value: unknown,
): readonly { readonly list: SummaryListName; readonly key: string }[] | null {
  if (!Array.isArray(value)) return null;
  const validLists = new Set<string>(SUMMARY_LIST_NAMES);
  const removed: { readonly list: SummaryListName; readonly key: string }[] =
    [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.list !== 'string' ||
      !validLists.has(candidate.list) ||
      typeof candidate.key !== 'string' ||
      candidate.key.trim().length === 0
    ) {
      continue;
    }
    removed.push({
      list: candidate.list as SummaryListName,
      key: candidate.key.trim(),
    });
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 生产生成器：模型提示 → 收集文本 → 解析
// ---------------------------------------------------------------------------

/** 摘要增量生成的缺省系统提示（中文，要求严格 JSON 输出）。 */
const DEFAULT_DELTA_SYSTEM_PROMPT = `你是 modou 的上下文增量压缩器。输入是一段被折叠的早期对话与当前的持久摘要状态；你要产出该对话的**增量**，让压缩器把它合并进既有摘要（增量合并，不是全量重写）。

增量是严格 JSON 对象（只输出 JSON，不要 markdown 围栏、不要任何解释文字），字段如下：
- "goal"：字符串——仅当摘要中的目标为空时给出（goal 是任务锚，永不改写）；
- "constraints" / "decisions" / "done" / "todo" / "findings" / "openQuestions"：条目数组，元素为 {"id"?: 字符串, "text": 字符串}；
- "filesTouched"：文件数组，元素为 {"path": 字符串, "note"?: 字符串}（只追加客观事实，绝不删除）；
- "removed"：删除声明数组，元素为 {"list": 列表名, "key": 字符串}，key 是既有条目的 id 或原文。

合并语义（压缩器按此处理）：
1. 同 id 或同原文的条目：新版本替换旧版本（「改」）；
2. 无 id 且文本已存在的条目：去重；新文本：追加（「增」）；
3. removed 显式删除：仅当折叠区推翻了既有条目（待办已完成、问题已解决、决定已被取代）时使用；list 只允许 constraints / decisions / done / todo / findings / openQuestions；
4. 折叠区没有新信息时输出空增量即可（如 {"findings": []}）。

要求：
- 只提取折叠区里**新出现**的信息；既有摘要已覆盖的内容不要重复；
- 条目 text 用简洁中文或代码标识符，不超过 80 字；
- 你输出的必须是合法 JSON——解析失败会导致本轮压缩整体失败。`;

/** 把既有状态 + 折叠区对话文本拼成 user 提示。 */
function buildDeltaUserPrompt(state: SummaryState, foldedText: string): string {
  const lines: string[] = [
    `当前摘要状态（rev=${state.rev}）：`,
    serializeSummary(state),
    '',
    '被折叠的早期对话（将被摘要块代替，日志原文仍在）：',
    foldedText.length === 0 ? '（无）' : foldedText,
    '',
    '输出增量 JSON：',
  ];
  return lines.join('\n');
}

/** createModelDeltaGenerator 的构造选项。 */
export interface ModelDeltaGeneratorOptions {
  /** 覆盖缺省系统提示（测试可注入简化版）。 */
  readonly system?: string;
}

/**
 * 生产摘要增量生成器：输入折叠区原文 + 既有状态 → provider 生成 JSON delta。
 *
 * - 收集 provider 流里的全部 text_delta 拼成输出文本；
 * - `parseSummaryDelta` 解析（容错 JSON / 剥围栏 / 字段规范化）；
 * - 解析失败 / 空输出 / provider 抛错 → 抛 `SummaryDeltaError`（调用方捕获
 *   发 notice 降级，不崩）；错误消息含模型原始输出（截断），可诊断。
 */
export function createModelDeltaGenerator(
  provider: ModelProvider,
  options: ModelDeltaGeneratorOptions = {},
): (input: {
  readonly folded: readonly ModelMessage[];
  readonly state: SummaryState;
}) => Promise<SummaryDelta> {
  const system = options.system ?? DEFAULT_DELTA_SYSTEM_PROMPT;
  return async ({ folded, state }) => {
    const foldedText = folded.map(serializeMessageText).join('\n');
    let text: string;
    try {
      text = await collectChatText(provider, {
        system,
        messages: [
          { role: 'user', content: buildDeltaUserPrompt(state, foldedText) },
        ],
      });
    } catch (caught) {
      throw new SummaryDeltaError(
        `摘要生成请求失败：${describeCause(caught)}`,
        { cause: caught },
      );
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new SummaryDeltaError('摘要生成返回空文本（模型未产出 JSON 增量）');
    }
    const delta = parseSummaryDelta(trimmed);
    if (delta === null) {
      throw new SummaryDeltaError(
        `摘要生成未产出合法 JSON 增量：${truncate(trimmed, 160)}`,
      );
    }
    return delta;
  };
}

/** 收集 provider 流的文本增量（忽略 thinking / usage / finish）。 */
async function collectChatText(
  provider: ModelProvider,
  input: { readonly system: string; readonly messages: ModelMessage[] },
): Promise<string> {
  let text = '';
  for await (const event of provider.streamChat(input)) {
    if (event.type === 'text_delta') text += event.delta;
  }
  return text;
}

/** 归一任意错误为可读文本（含消息与类型）。 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** 截断长文本（错误消息带模型原始输出时的长度上限）。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
