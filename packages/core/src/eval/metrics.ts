import type { TokenUsage } from '../provider/types';
import type { RuntimeEvent } from '../runtime/loop';

/**
 * 评测度量（骨架）：为 0.9.0 五项度量打底。
 *
 * 0.9.0 验收门（phase-1-mvp）要求五项指标：任务完成率 ≥60% / 工具成功率 ≥90%
 * / 编辑一次命中率 ≥85% / 压缩后延续率 ≥80%（0.6.0 的维度，本模块不涉及）/
 * token 基线。本骨架采集前三项 + token 用量与轮次，作为基线度量来源。
 */
export interface EvalMetrics {
  /** 工具调用总数（模型发起的 tool_use 数）。 */
  readonly toolCalls: number;
  /** 成功工具调用数（tool_result ok）。 */
  readonly toolSuccesses: number;
  /** 失败工具调用数（tool_result ok=false）。 */
  readonly toolFailures: number;
  /** 工具调用成功率（成功 / 总数；无调用时为 undefined）。 */
  readonly toolSuccessRate?: number;
  /** Edit 工具调用数。 */
  readonly editCalls: number;
  /** Edit 一次命中数（old_string 首次唯一匹配成功，即 ADR 0006 的「编辑一次命中」）。 */
  readonly editHits: number;
  /** 编辑一次命中率（命中 / 调用；无 Edit 调用时为 undefined）。 */
  readonly editHitRate?: number;
  /** 实际轮次（模型请求数）。 */
  readonly turns: number;
  /** 模型最终文本长度（字符；token 基线度量的粗糙代理）。 */
  readonly textLength: number;
  /** 累计 token 用量（token 基线度量的来源）。 */
  readonly usage: TokenUsage;
}

/**
 * 从一轮运行的事件流采集度量。
 *
 * 关联关系：`tool_use`（id → name）与 `tool_result`（id → ok）配对——
 * `tool_result` 事件本身不带工具名，需按 id 回溯 `tool_use` 取得；
 * loop 保证「先发 tool_use、后发对应 tool_result」的顺序。
 */
export function collectMetrics(
  events: readonly RuntimeEvent[],
  text: string,
  turns: number,
  usage: TokenUsage,
): EvalMetrics {
  const toolNameById = new Map<string, string>();
  let toolCalls = 0;
  let toolSuccesses = 0;
  let editCalls = 0;
  let editHits = 0;

  for (const event of events) {
    if (event.type === 'tool_use') {
      toolCalls += 1;
      toolNameById.set(event.id, event.name);
    } else if (event.type === 'tool_result') {
      const name = toolNameById.get(event.id);
      if (name === 'edit') {
        editCalls += 1;
        if (event.ok) editHits += 1;
      }
      if (event.ok) toolSuccesses += 1;
    }
  }

  const toolFailures = toolCalls - toolSuccesses;
  return {
    toolCalls,
    toolSuccesses,
    toolFailures,
    toolSuccessRate: toolCalls > 0 ? toolSuccesses / toolCalls : undefined,
    editCalls,
    editHits,
    editHitRate: editCalls > 0 ? editHits / editCalls : undefined,
    turns,
    textLength: text.length,
    usage,
  };
}
