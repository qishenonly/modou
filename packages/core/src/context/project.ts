/**
 * 上下文分项估算（design 002 §7.1「投影：分段组装」，T-063 /context 视图）。
 *
 * 002 7.1 把请求上下文切成三段：稳定前缀（系统提示 / 工具定义 / 项目指令）、
 * 半稳定（压缩摘要，0.7.0）、易变区（历史 / 工具输出 / 当前输入）。本模块把
 * 「每段的 token 占用」算出来，供 `/context` 分项展示与预算超支时定位膨胀段：
 *
 * - `estimateContextSections`：纯估算——按分段把 thread 序列化为文本，
 *   复用 budget.ts 的 estimateTokens 逐段计价（中文约 1 token/字、英文约
 *   4 字符/token 的字符级近似，详见 budget.ts「精度取舍」）；
 * - `buildContextState`：估算 + 预算账本 drift，产出协议 `context_state`
 *   事件负载（分项 + 合计 + 粗估 vs 实测偏差），loop 每轮收尾发出、TUI
 *   `/context` 消费；
 * - `serializeMessageText` / `serializeToolsText`：与 loop 请求级粗估共用
 *   的序列化器，从 runtime/loop.ts 迁入本模块——请求前粗估与分项视图必须
 *   同源（002 7.3「粗估与实测的偏差要记录」，同源才谈得上偏差）。
 *
 * 分段口径（0.6.0，压缩 0.7.0 之前）：
 * - `system`：系统提示词原文；
 * - `tools`：工具定义序列化文本（name + description + 参数 JSON Schema，
 *   对应 provider 随请求序列化的原生 tools 载荷）；
 * - `instructions`：项目指令（AGENTS.md）。0.8.0 才有，此前恒为 0 占位；
 * - `history`：易变区里的非工具消息——user 输入、assistant 文本/推理/工具调用
 *   参数（含当前轮）；
 * - `tool_output`：易变区里的工具输出——role `tool` 消息的 tool-result 载荷。
 *
 * 依赖方向：只依赖协议类型（protocol/events）与预算估算（budget），
 * 不感知 provider / runtime 内部。
 */

import type { ModelMessage } from 'ai';
import { estimateTokens, type TokenDrift } from './budget';
import type { BudgetLedger } from './budget';
import type { ContextSection, ContextStateData } from '../protocol/events';

// ---------------------------------------------------------------------------
// 工具集视图（002 2.2：Context 只依赖 Session 与 Provider——工具定义分项
// 只取注册表的 list()/toJsonSchema()，用结构接口解耦，不 import tools 全形）
// ---------------------------------------------------------------------------

/** 工具集视图：serializeToolsText 所需的最小表面（ToolRegistry 结构上满足）。 */
export interface ToolsSource {
  readonly list: () => readonly {
    readonly name: string;
    readonly description: string;
  }[];
  readonly toJsonSchema: (name: string) => unknown;
}

// ---------------------------------------------------------------------------
// 分项名称（002 7.1 分段；协议 context_state.sections[].name 的取值）
// ---------------------------------------------------------------------------

/** 分项名称：协议负载里的机器可读标识（TUI 负责映射为中文标签）。 */
export type ContextSectionName =
  'system' | 'tools' | 'instructions' | 'history' | 'tool_output';

/** 分项展示顺序（稳定前缀在前、易变区在后，与 002 7.1 分段一致）。 */
export const CONTEXT_SECTION_NAMES: readonly ContextSectionName[] = [
  'system',
  'tools',
  'instructions',
  'history',
  'tool_output',
];

// ---------------------------------------------------------------------------
// 序列化（与 runtime 请求级粗估同源，见文件头）
// ---------------------------------------------------------------------------

/**
 * 展平一条 ModelMessage 为纯文本（预算粗估用：与发给模型的正文同源）。
 *
 * - text part 取原文；reasoning 取推理文本；
 * - tool-call / tool-result 序列化为 `[tool-call:名称] 参数JSON` 形态
 *   （模型实际收到的工具调用 / 结果是 JSON，按 JSON 文本计入）;
 * - file / image 等二进制载体不以字节计入（base64 会严重偏斜估算），
 *   以 `[file:媒体类型]` 占位——本估算是粗估，精确值交给 drift() 校准；
 * - 稀有 part 类型（custom / reasoning-file / 工具审批）以类型名占位。
 */
export function serializeMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  const parts: string[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
      case 'reasoning':
        parts.push(part.text);
        break;
      case 'tool-call':
        parts.push(
          `[tool-call:${part.toolName}] ${JSON.stringify(part.input)}`,
        );
        break;
      case 'tool-result':
        parts.push(
          `[tool-result:${part.toolName}] ${JSON.stringify(part.output)}`,
        );
        break;
      case 'file':
        parts.push(`[file:${part.mediaType}]`);
        break;
      case 'image':
        parts.push('[image]');
        break;
      default:
        parts.push(`[${part.type}]`);
        break;
    }
  }
  return parts.join('\n');
}

/**
 * 工具定义文本（预算粗估用）：近似 provider 随请求序列化的 tools 数组
 * （name + description + 参数 JSON Schema）。系统提示词已内嵌工具说明文本
 * （prompt/system.ts 双通道），此处计入的是 provider 另行发送的原生 tools
 * 载荷——两部分都会真实计费，粗估都应覆盖；固定冗余由 drift() 度量吸收。
 */
export function serializeToolsText(source: ToolsSource): string {
  const lines: string[] = [];
  for (const tool of source.list()) {
    lines.push(`${tool.name}: ${tool.description}`);
    lines.push(JSON.stringify(source.toJsonSchema(tool.name)));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 分项估算
// ---------------------------------------------------------------------------

/** estimateContextSections / buildContextState 的入参。 */
export interface EstimateContextInput {
  /** 系统提示词原文（prompt/system.ts 产出，可能为空串）。 */
  readonly system: string;
  /**
   * 工具集（缺省 = 无工具，tools 分项按 0 计）。传入与 loop 发起请求时同一个
   * 注册表（结构上满足 ToolsSource），保证「工具定义」分项与请求级粗估同源。
   */
  readonly tools?: ToolsSource;
  /**
   * 当前消息线程（AI SDK ModelMessage）：user / assistant / tool 消息都在其中。
   * loop 收尾时传内部 thread；TUI /context 传投影出的历史 messages。
   */
  readonly thread: readonly ModelMessage[];
  /**
   * 预算账本（可选）：提供时在结果里带上粗估 vs 实测 drift
   * （budget.drift()），供 `/context` 展示分词器选型偏差（002 7.3）。
   */
  readonly budget?: BudgetLedger;
  /**
   * 项目指令文本（AGENTS.md）。0.8.0 才真正加载，此前缺省空串 =
   * instructions 分项恒为 0（占位，视图仍显示该行）。
   */
  readonly instructions?: string;
}

/** estimateContextSections 的产出：分项 + 合计 + 可选 drift。 */
export interface ContextEstimate {
  /** 五个分项（稳定前缀在前），tokens 为 estimateTokens 的字符级近似。 */
  readonly sections: readonly ContextSection[];
  /** 各分项合计（估算输入 token；drift() 由此与实际 usage 校准）。 */
  readonly total: number;
  /** 预算账本 drift（未提供账本时全零，见 ZERO_DRIFT）。 */
  readonly drift: TokenDrift;
}

/** 未提供账本时的占位 drift（全零，避免 undefined 泄漏进协议）。 */
const ZERO_DRIFT: TokenDrift = Object.freeze({
  estimated: 0,
  actual: 0,
  error: 0,
  rate: 0,
});

/**
 * 按 002 7.1 分段估算请求上下文各分项的 token 占用（T-063）。
 *
 * 分段口径见文件头；thread 按消息角色切分：role `tool` 的消息（tool-result）
 * 计入 `tool_output`，其余（user / assistant，含工具调用参数）计入 `history`。
 * 每个分项复用 estimateTokens，因此对 thread 的追加单调不降、与请求级粗估
 * 同源（loop 的 estimateRequestText 直接调用本函数取 .total）。
 *
 * `budget` 可选：提供时返回账本的累计 drift（粗估 vs 实测，跨请求累计），
 * `/context` 视图据此展示「近似 vs 实测」偏差——偏差大意味着字符级近似与
 * 该供应商分词器的系统性偏离（002 7.3：分词器选错的信号）。
 */
export function estimateContextSections(
  input: EstimateContextInput,
): ContextEstimate {
  const systemTokens = estimateTokens(input.system);
  const toolsTokens =
    input.tools === undefined
      ? 0
      : estimateTokens(serializeToolsText(input.tools));
  const instructionsTokens = estimateTokens(input.instructions ?? '');

  // 易变区按消息角色切分：工具输出（role tool）单独计价，其余全算历史。
  const historyParts: string[] = [];
  const toolOutputParts: string[] = [];
  for (const message of input.thread) {
    const text = serializeMessageText(message);
    if (text.length === 0) continue;
    if (message.role === 'tool') toolOutputParts.push(text);
    else historyParts.push(text);
  }

  const sections: readonly ContextSection[] = [
    { name: 'system', tokens: systemTokens },
    { name: 'tools', tokens: toolsTokens },
    { name: 'instructions', tokens: instructionsTokens },
    { name: 'history', tokens: estimateTokens(historyParts.join('\n')) },
    { name: 'tool_output', tokens: estimateTokens(toolOutputParts.join('\n')) },
  ];
  const total = sections.reduce((sum, section) => sum + section.tokens, 0);

  return {
    sections,
    total,
    drift: input.budget?.drift() ?? ZERO_DRIFT,
  };
}

// ---------------------------------------------------------------------------
// 协议 context_state 负载
// ---------------------------------------------------------------------------

/**
 * 组装协议 `context_state` 事件负载（分项 + 合计 + budget drift，T-063）。
 *
 * - `nearCompaction`：压缩是否临近。0.6.0 不做压缩（0.7.0），恒 false；
 *   0.7.0 引入压缩触发阈值后在此计算；
 * - `sections` / `total`：estimateContextSections 的分项与合计；
 * - `drift`：预算账本累计粗估 vs 实测偏差（协议 ContextDrift 形态）。
 *
 * loop 每轮收尾以「最近一轮发给模型的请求消息」（T-070：启用压缩后为投影
 * 后的「摘要块 + 近 N 轮原文」，未启用 = 内部 thread）+ 当轮账本调用本函数
 * 并发出 context_state；TUI `/context` 以「系统提示 + 工具 + 投影历史 + 账本」
 * 实时组装同款负载。
 */
export function buildContextState(
  input: EstimateContextInput,
): ContextStateData {
  const estimate = estimateContextSections(input);
  return {
    nearCompaction: false,
    sections: estimate.sections,
    total: estimate.total,
    drift: {
      estimated: estimate.drift.estimated,
      actual: estimate.drift.actual,
      error: estimate.drift.error,
      rate: estimate.drift.rate,
    },
  };
}
