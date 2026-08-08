/**
 * 触碰路径收集（T-101）：从会话日志 / 工具调用收集 agent 触碰过的文件路径，
 * 供快照引擎做「仅快照触碰路径」模式（002 风险表：大仓库上单次快照 < 1 秒的关键）。
 *
 * 数据源：会话日志记录（SessionRecord）——
 * - `write` / `edit` 工具调用成功（tool_result ok:true）：目标文件路径
 *   （payload.path 优先，它是工具 realpath 后的绝对路径；缺省从调用入参 path
 *   相对 cwd 解析）；
 * - `bash` 工具：无法从日志可靠得知命令触碰了哪些文件（可能 mkdir / rm / mv /
 *   curl 任意路径）——**不猜测**。日志中出现任一成功的 bash 调用即返回空集，
 *   调用方回落全量快照（全量尊重 .gitignore + node_modules 排除）——bash 场景
 *   （含与 write/edit 混用）的实际行为恒为「全量」，宁可多快照也不漏。
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
 * - 任一成功 bash 调用 → 返回空集（bash 触碰了哪些文件无法可靠得知，调用方
 *   回落全量快照兜底——与 write/edit 混用亦然，宁多不漏）；
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

  // 任一成功的 bash 调用 → 无法可靠得知触碰路径，回落全量快照（返回空集）
  let bashSucceeded = false;
  const touched = new Set<string>();
  for (const record of records) {
    if (record.kind !== 'tool_result' || !record.data.ok) continue;
    const call = callIdToCall.get(record.data.callId);
    if (call === undefined) continue;
    if (call.name === 'bash') {
      bashSucceeded = true;
      continue;
    }
    if (call.name !== 'write' && call.name !== 'edit') continue;
    const path = resolvePath(record.data, call.input, cwd);
    if (path === null) continue;
    touched.add(path);
  }
  if (bashSucceeded) return [];
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
