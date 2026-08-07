/**
 * 会话恢复（design 002 4.1「/resume：重放日志重建状态」，T-061）。
 *
 * 会话日志是「唯一真相」：追加写、不可变、完整（log.ts），**从没被破坏过**，
 * 因此 /resume 只需重放日志即可重建状态，无需任何快照：
 *
 * - `listSessionsForResume`：列出可恢复会话（时间倒序，含摘要：首尾时间/条数/
 *   简要开头——首条 user 消息文本截断）；
 * - `resumeSession`：读一条会话 → 投影出模型消息序列（user / assistant /
 *   tool_result 序列 → AI SDK ModelMessage，恢复后模型能看到之前的对话与工具
 *   结果）、重建会话级已读文件集合（readFiles：name 为 read 且 ok 的条目，
 *   resume 后 edit/write 不被防盲写拒绝）、累计 token 用量（usage 条目求和）。
 *   返回「可继续的输入」数据，调用方（TUI）与 provider / tools / options 拼装
 *   成 RunAgentTurnInput 后继续对话。
 *
 * 续写语义（与 runtime/loop.ts 的 `loggedUserCount` 配合）：调用方把投影出的
 * 完整历史 + 新增 user 消息传入 runAgentTurn，并把历史里的 user 消息条数作为
 * `loggedUserCount`——loop 据此只把新增的 user 消息追加进会话日志，历史不重复
 * 落盘（002 4.1「日志永远不被裁剪」，重复落盘同样违背「唯一真相」的简洁性）。
 *
 * 依赖方向：本模块只依赖 node 内置模块、协议类型（UsageData）与 session 自身
 * （log/store），不依赖 provider / runtime。usage 求和结果复用协议 UsageData，
 * 与 log.ts 的 UsageEntryData 同形（略 totalCost）。
 */

import type { ModelMessage, TextPart, ToolCallPart, ToolResultPart } from 'ai';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { UsageData } from '../protocol';
import type { SessionRecord, ToolResultEntryData } from './log';
import type { SessionStore, SessionSummary } from './store';

/** 简要开头的截断长度（字符）。 */
export const RESUME_PREVIEW_MAX_CHARS = 60;

// ---------------------------------------------------------------------------
// 列会话
// ---------------------------------------------------------------------------

/** 一条可恢复会话的列表项（供 TUI 选择器展示）。 */
export interface ResumeCandidate {
  readonly projectHash: string;
  readonly sessionId: string;
  /** 日志文件绝对路径。 */
  readonly path: string;
  /** 首条记录 ts（全坏行时为文件 mtime，与 SessionSummary 语义一致）。 */
  readonly firstTs: number;
  /** 末条记录 ts（全坏行时为文件 mtime）。 */
  readonly lastTs: number;
  /** 记录里的最大 seq。 */
  readonly maxSeq: number;
  /** 有效记录数。 */
  readonly entryCount: number;
  /** 文件字节数。 */
  readonly sizeBytes: number;
  /** 简要开头：首条 user 消息文本（换行折叠、截断到 RESUME_PREVIEW_MAX_CHARS）。 */
  readonly preview: string;
}

/**
 * 列出可恢复会话，按时间倒序（末条记录 ts 降序，同 ts 按 sessionId 倒序保证
 * 确定性——与 SessionStore.list 一致）。
 *
 * - 传 `projectHash`：只列该项目的会话；
 * - 不传：列出所有项目下的会话（先 projects() 再逐个 list，合并排序）。
 *
 * 每条附 `preview`（首条 user 消息的截断文本），供选择器直接展示。
 */
export async function listSessionsForResume(
  store: SessionStore,
  projectHashInput?: string,
): Promise<ResumeCandidate[]> {
  const projects =
    projectHashInput === undefined
      ? await store.projects()
      : [projectHashInput];
  const summaries: SessionSummary[] = [];
  for (const project of projects) {
    summaries.push(...(await store.list(project)));
  }
  summaries.sort(
    (a, b) => b.lastTs - a.lastTs || b.sessionId.localeCompare(a.sessionId),
  );

  const candidates: ResumeCandidate[] = [];
  for (const summary of summaries) {
    const preview = await previewOf(
      store,
      summary.projectHash,
      summary.sessionId,
    );
    candidates.push({
      projectHash: summary.projectHash,
      sessionId: summary.sessionId,
      path: summary.path,
      firstTs: summary.firstTs,
      lastTs: summary.lastTs,
      maxSeq: summary.maxSeq,
      entryCount: summary.entryCount,
      sizeBytes: summary.sizeBytes,
      preview,
    });
  }
  return candidates;
}

/** 取一条会话的简要开头：首条 user 消息文本（折叠空白 + 截断）。 */
async function previewOf(
  store: SessionStore,
  projectHashInput: string,
  sessionId: string,
): Promise<string> {
  const read = await store.read(projectHashInput, sessionId);
  if (read === null) return '';
  for (const record of read.records) {
    if (record.kind === 'user') {
      const collapsed = record.data.text.replace(/\s+/g, ' ').trim();
      if (collapsed.length === 0) continue;
      return collapsed.length > RESUME_PREVIEW_MAX_CHARS
        ? `${collapsed.slice(0, RESUME_PREVIEW_MAX_CHARS)}…`
        : collapsed;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// 恢复单条会话
// ---------------------------------------------------------------------------

/** resumeSession 的构造选项。 */
export interface ResumeSessionOptions {
  /**
   * 工作目录：重建 readFiles 时解析相对路径用（read 入参的 path 相对 cwd）。
   * 缺省 process.cwd()。
   */
  readonly cwd?: string;
}

/** 一条已恢复会话：可继续的输入数据（调用方与 provider/tools/options 拼装）。 */
export interface ResumedSession {
  readonly projectHash: string;
  readonly sessionId: string;
  /** 日志文件绝对路径。 */
  readonly path: string;
  /** 首条记录 ts（空会话为 0）。 */
  readonly firstTs: number;
  /** 末条记录 ts（空会话为 0）。 */
  readonly lastTs: number;
  /** 有效记录数。 */
  readonly entryCount: number;
  /**
   * 重建的完整历史消息（AI SDK ModelMessage）：user / assistant / tool_result
   * 序列投影，同轮 tool 结果归并为一条 tool 消息。恢复后模型能看到之前的对话
   * 与工具结果（002 4.1「上下文与状态一致」）。续写时在此追加新 user 消息。
   */
  readonly messages: readonly ModelMessage[];
  /**
   * 重建的会话级已读文件集合（绝对路径）：name 为 read 且 ok 的 tool_result
   * 条目，realpath 归一。作为 RunAgentTurnInput.readFiles 的种子，使 resume 后
   * edit/write 不被防盲写拒绝（同一会话内 Read 过即可覆盖）。
   */
  readonly readFiles: ReadonlySet<string>;
  /**
   * 会话原始记录（resume 重放的数据源）：调用方据此重建任何可推导状态而不必
   * 再次读日志文件——如 T-070 用 `rebuildSummaryState` 从 compaction 条目恢复
   * 持久摘要状态（/resume 后继续增量压缩）。
   */
  readonly records: readonly SessionRecord[];
  /** 累计 token 用量（usage 条目逐项求和；供状态栏种子等 UI 展示）。 */
  readonly usage: UsageData;
}

/**
 * 读一条会话并重建可继续的状态：会话不存在时返回 null（坏行跳过不影响——
 * 有效记录照常投影，skippedLines 由 store.read 容忍）。
 */
export async function resumeSession(
  store: SessionStore,
  projectHashInput: string,
  sessionId: string,
  options: ResumeSessionOptions = {},
): Promise<ResumedSession | null> {
  const cwd = options.cwd ?? process.cwd();
  const read = await store.read(projectHashInput, sessionId);
  if (read === null) return null;

  const messages = projectMessages(read.records);
  const readFiles = await rebuildReadFiles(read.records, cwd);
  const usage = accumulateUsage(read.records);
  const firstTs = read.records.length > 0 ? read.records[0].ts : 0;
  const lastTs =
    read.records.length > 0 ? read.records[read.records.length - 1].ts : 0;
  return {
    projectHash: projectHashInput,
    sessionId: read.sessionId,
    path: read.path,
    firstTs,
    lastTs,
    entryCount: read.records.length,
    messages,
    readFiles,
    records: read.records,
    usage,
  };
}

// ---------------------------------------------------------------------------
// 投影：会话日志 → AI SDK ModelMessage（002 4.1「上下文是日志的投影」）
// ---------------------------------------------------------------------------

/**
 * 把会话记录投影为 AI SDK 模型消息序列（resume 的初始 messages）。
 *
 * 规则：
 * - `user` → user 消息（text 原文）；
 * - `assistant` → assistant 消息：text 非空时带 text part，calls 带
 *   tool-call part（入参已脱敏，log 里记录的就是脱敏后的值）；
 * - `tool_result` → 归并进当前 tool 结果组；同轮连续多个 tool_result 归并为
 *   一条 tool 消息（与 loop 的 feedBackToolRound 把一轮全部结果打进一条
 *   tool 消息一致）。callId → 工具名从 assistant 条目的 calls 建立映射，
 *   映射缺失时兜底 'unknown'（防御坏日志）；
 * - `turn_start / turn_end / usage / notice / error` 是过程性条目，不投影。
 */
export function projectMessages(
  records: readonly SessionRecord[],
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const callIdToName = new Map<string, string>();
  // 当前待关闭的 tool 结果组（同一 assistant 轮次的全部 tool_result）
  let pendingToolResults: ToolResultPart[] = [];

  const flushTools = (): void => {
    if (pendingToolResults.length > 0) {
      messages.push({ role: 'tool', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const record of records) {
    switch (record.kind) {
      case 'user':
        flushTools();
        messages.push({ role: 'user', content: record.data.text });
        break;
      case 'assistant': {
        flushTools();
        const parts: Array<TextPart | ToolCallPart> = [];
        if (record.data.text.length > 0) {
          parts.push({ type: 'text', text: record.data.text });
        }
        for (const call of record.data.calls ?? []) {
          callIdToName.set(call.id, call.name);
          parts.push({
            type: 'tool-call',
            toolCallId: call.id,
            toolName: call.name,
            input: call.input,
          });
        }
        messages.push({ role: 'assistant', content: parts });
        break;
      }
      case 'tool_result': {
        pendingToolResults.push({
          type: 'tool-result',
          toolCallId: record.data.callId,
          toolName: callIdToName.get(record.data.callId) ?? 'unknown',
          output: record.data.ok
            ? { type: 'text', value: record.data.forModel }
            : { type: 'error-text', value: record.data.forModel },
        });
        break;
      }
      default:
        // turn_start / turn_end / usage / notice / error：过程性条目，不投影；
        // 到达下一轮的分界时把上一轮 tool 结果组收尾。
        flushTools();
        break;
    }
  }
  flushTools();
  return messages;
}

/** 统计消息序列里的 user 消息条数（resume 续写时给 loop 的 loggedUserCount）。 */
export function countUserMessages(messages: readonly ModelMessage[]): number {
  return messages.reduce(
    (count, message) => (message.role === 'user' ? count + 1 : count),
    0,
  );
}

// ---------------------------------------------------------------------------
// readFiles 重建（read 过的文件 resume 后 edit/write 不被拒）
// ---------------------------------------------------------------------------

/**
 * 从会话记录重建会话级已读文件集合。
 *
 * 对每个「assistant 调用了 read 且对应 tool_result ok」的调用，取其文件路径
 * （tool_result payload.path 优先——read 工具成功时恒为解析后的绝对路径；
 * 否则从调用入参 path 相对 cwd 解析），再 realpath 归一（与 read 工具经
 * onFileRead 上报的语义一致：Edit/Write 的防盲写检查用 absPath 或 realpath
 * 任一命中即可，见 tools/impl/edit.ts ②）。
 *
 * realpath 失败（文件已被删）时回退到解析后的绝对路径——路径仍入集，后续
 * Edit 会因文件不存在返回 not_found 而非误报「未读过」，诊断更准确。
 */
export async function rebuildReadFiles(
  records: readonly SessionRecord[],
  cwd: string,
): Promise<Set<string>> {
  // callId → 调用信息（assistant 条目的 calls；入参已脱敏）
  const callIdToCall = new Map<string, { name: string; input: unknown }>();
  for (const record of records) {
    if (record.kind !== 'assistant') continue;
    for (const call of record.data.calls ?? []) {
      callIdToCall.set(call.id, { name: call.name, input: call.input });
    }
  }

  const files = new Set<string>();
  for (const record of records) {
    if (record.kind !== 'tool_result' || !record.data.ok) continue;
    const call = callIdToCall.get(record.data.callId);
    if (call === undefined || call.name !== 'read') continue;
    const path = resolveReadPath(record.data, call.input, cwd);
    if (path === null) continue;
    const normalized = await realpath(path).catch(() => path);
    files.add(normalized);
  }
  return files;
}

/** 解析一次 read 调用的目标文件路径（payload.path 优先，入参兜底）。 */
function resolveReadPath(
  result: ToolResultEntryData,
  input: unknown,
  cwd: string,
): string | null {
  const payloadPath =
    typeof result.payload === 'object' && result.payload !== null
      ? (result.payload as { readonly path?: unknown }).path
      : undefined;
  if (typeof payloadPath === 'string' && payloadPath.length > 0) {
    return isAbsolute(payloadPath) ? payloadPath : resolve(cwd, payloadPath);
  }
  const argPath =
    typeof input === 'object' && input !== null
      ? (input as { readonly path?: unknown }).path
      : undefined;
  if (typeof argPath === 'string' && argPath.length > 0) {
    return isAbsolute(argPath) ? argPath : resolve(cwd, argPath);
  }
  return null;
}

// ---------------------------------------------------------------------------
// usage 累计（usage 条目逐项求和）
// ---------------------------------------------------------------------------

/**
 * 累计 token 用量：把全部 usage 条目的分项相加。
 * 某分项从未出现时保持 undefined（与 loop 的 accumulateUsage 语义一致）；
 * 部分条目缺某字段时按 0 计入该分项总和。
 */
export function accumulateUsage(records: readonly SessionRecord[]): UsageData {
  const total: {
    inputTokens?: number;
    outputTokens?: number;
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } = {};
  const plus = (
    current: number | undefined,
    partial: number | undefined,
  ): number | undefined =>
    current === undefined && partial === undefined
      ? undefined
      : (current ?? 0) + (partial ?? 0);
  for (const record of records) {
    if (record.kind !== 'usage') continue;
    total.inputTokens = plus(total.inputTokens, record.data.inputTokens);
    total.outputTokens = plus(total.outputTokens, record.data.outputTokens);
    total.noCacheTokens = plus(total.noCacheTokens, record.data.noCacheTokens);
    total.cacheReadTokens = plus(
      total.cacheReadTokens,
      record.data.cacheReadTokens,
    );
    total.cacheWriteTokens = plus(
      total.cacheWriteTokens,
      record.data.cacheWriteTokens,
    );
  }
  return total;
}
