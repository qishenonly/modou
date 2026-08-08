/**
 * 触碰路径收集（T-101）：从会话日志 / 工具调用收集 agent 触碰过的文件路径，
 * 供快照引擎做「仅快照触碰路径」模式（002 风险表：大仓库上单次快照 < 1 秒的关键）。
 *
 * 数据源：会话日志记录（SessionRecord）——
 * - `write` / `edit` 工具调用成功（tool_result ok:true）：目标文件路径
 *   （payload.path 优先，它是工具 realpath 后的绝对路径；缺省从调用入参 path
 *   相对 cwd 解析）；
 * - `bash` 工具：无法从日志可靠得知命令触碰了哪些文件（可能 mkdir / rm / mv /
 *   curl 任意路径）——**不猜测**。调用方在本函数返回空集时回落全量快照（全量
 *   尊重 .gitignore + node_modules 排除），因此 bash 场景的实际行为是「全量」，
 *   宁可多快照也不漏。
 *
 * 用途：TUI 每轮快照前把当前会话日志传进来取路径集，作为 snapshot({ paths })。
 */

import { isAbsolute, resolve } from 'node:path';
import type { SessionRecord } from '../session/log';

/** 输出路径的解析基准（cwd 缺省 process.cwd()）。 */
export interface CollectTouchedPathsOptions {
  readonly cwd?: string;
}

/**
 * 从会话日志收集 agent 触碰过的文件路径（绝对路径，去重保序）。
 * - 只收 `write` / `edit` 且 tool_result ok 的调用（失败的调用没改动文件，不算触碰）；
 * - 返回空集时调用方应回落全量快照（bash 等不可知场景由全量兜底）；
 * - read / grep / glob 是只读工具，不触碰文件，不纳入。
 */
export function collectTouchedPaths(
  records: readonly SessionRecord[],
  options: CollectTouchedPathsOptions = {},
): string[] {
  const cwd = options.cwd ?? process.cwd();
  // callId → 调用信息（assistant 条目的 calls；入参已脱敏）
  const callIdToCall = new Map<string, { name: string; input: unknown }>();
  for (const record of records) {
    if (record.kind !== 'assistant') continue;
    for (const call of record.data.calls ?? []) {
      callIdToCall.set(call.id, { name: call.name, input: call.input });
    }
  }

  const touched = new Set<string>();
  for (const record of records) {
    if (record.kind !== 'tool_result' || !record.data.ok) continue;
    const call = callIdToCall.get(record.data.callId);
    if (call === undefined) continue;
    if (call.name !== 'write' && call.name !== 'edit') continue;
    const path = resolvePath(record.data, call.input, cwd);
    if (path === null) continue;
    touched.add(path);
  }
  return [...touched];
}

/** 解析一次写工具调用的目标文件路径（payload.path 优先，入参兜底）。 */
function resolvePath(
  result: { readonly payload?: unknown },
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
