/**
 * 预算核算（design 002 §7.3，T-062）：请求前粗估、响应后用供应商 usage 校准、
 * 维护累计账本。
 *
 * 会话日志已记录每次请求的 usage（session/log.ts），/resume（T-061）经
 * session/resume.ts 的 accumulateUsage 求和；本模块在此基础上做完整预算核算：
 * loop 每次请求前用本地分词器粗估（estimateTokens），响应后以供应商 usage
 * 校准（BudgetLedger.recordUsage），并维护跨请求的累计账本，供 T-063 /context
 * 展示与分词器选型判断（002 §7.3：「偏差大说明分词器选错了」）。
 *
 * ## 精度取舍：不引重型 tokenizer
 *
 * 各供应商的官方分词器（cl100k_base / tiktoken / llama BPE 等）是几 MB 级
 * 词汇表 + 专用归一化逻辑，为「预算粗估」引入这类依赖不划算（约束：不引入
 * 重型 tokenizer）。0.6.0 采用字符级近似，两档计价：
 *
 * - 密文种（CJK 统一表意 / 扩展 / 兼容、CJK 标点、全角形式、日文假名、谚文）：
 *   按 1 token / 字符；
 * - 其余（拉丁字母、数字、符号、空白）：按 ceil(字符数 / 4)。
 *
 * 对应主流模型的两档经验值（中文约 0.7~1 token/字、英文约 4 字符/token），
 * 两档都略偏保守——宁可高估预算，也不让压缩/预算判断超前于真实消耗。
 * 该近似的系统误差由账本的 drift() 持续度量：一旦与供应商 usage 出现系统性
 * 偏离，就是更换「更贴近供应商的分词器」的信号（002 §14「分词器选型」ADR
 * 待定项的判据）。若未来需要更准，可引入 tiktoken 并按模型家族缓存编码器，
 * 估算接口不变。
 */

import type { UsageData } from '../protocol/events';

// ---------------------------------------------------------------------------
// 轻量 token 估算器
// ---------------------------------------------------------------------------

/**
 * 按 1 token/字符 计价的密文种码点区间：
 * CJK 统一表意、扩展 A、兼容表意、CJK 标点、全角形式、日文假名、谚文。
 * 这些文种 token 密度高（约 0.7~1 token/字），与「4 字符/token」的拉丁档
 * 差距悬殊，必须单独计价，否则中文文本会被低估 4 倍。
 */
const DENSE_CHAR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f], // CJK 标点（、。「」等）
  [0x3040, 0x30ff], // 日文假名（平假名 / 片假名）
  [0x3400, 0x4dbf], // CJK 统一表意扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意
  [0xac00, 0xd7af], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xff00, 0xffef], // 全角形式
];

/** 码点是否落在密文种区间（O(n)，n 为区间数，常量级）。 */
function isDenseChar(code: number): boolean {
  for (const [lo, hi] of DENSE_CHAR_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

/**
 * 估算一段文本的 token 数（轻量近似，见文件头「精度取舍」）。
 *
 * - 按 Unicode 码点遍历（for...of 天然处理代理对，emoji 等 astral 字符
 *   各计一个字符）；
 * - 密文种 1 token/字符，其余 ceil(字符数 / 4)；
 * - 对追加文本单调不降：estimateTokens(prefix + suffix) >= estimateTokens(prefix)。
 *
 * 这是纯文本估算法，不含消息角色 / 工具调用的框架开销——请求级估算由
 * runtime/loop.ts 负责拼装正文后调用，框架开销的固定偏差由账本 drift()
 * 度量并吸收。
 */
export function estimateTokens(text: string): number {
  let dense = 0;
  let sparse = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isDenseChar(code)) dense += 1;
    else sparse += 1;
  }
  return dense + Math.ceil(sparse / 4);
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

/** 账本的累计形态（可跨会话重建、可序列化、可作构造种子）。 */
export interface BudgetLedgerState {
  /** 供应商校准的累计输入 token（含缓存分项，是实际计费的输入口径） */
  readonly inputTokens: number;
  /** 供应商校准的累计输出 token */
  readonly outputTokens: number;
  /** 累计未命中缓存的输入 token */
  readonly noCacheTokens: number;
  /** 累计缓存命中的输入 token */
  readonly cacheReadTokens: number;
  /** 累计写入缓存的输入 token */
  readonly cacheWriteTokens: number;
  /** 请求前粗估的累计输入 token（仅含已校准的请求；失败请求的粗估已剔除） */
  readonly estimatedInput: number;
  /**
   * 累计粗估 vs 实测输入偏差（正 = 高估，负 = 低估）。
   * 恒等于 estimatedInput - inputTokens（配对会计的不变量）。
   */
  readonly estimateError: number;
}

/** 粗估 vs 实测偏差（drift() 的返回，供 T-063 展示与分词器选型判断）。 */
export interface TokenDrift {
  /** 累计粗估输入 token */
  readonly estimated: number;
  /** 供应商校准的累计实测输入 token */
  readonly actual: number;
  /** 偏差 = estimated - actual（正 = 高估，负 = 低估） */
  readonly error: number;
  /** 相对偏差率 = error / actual（actual 为 0 时取 0），便于跨请求量级对比 */
  readonly rate: number;
}

/**
 * 预算账本（002 7.3）：请求前粗估入账、响应后供应商 usage 校准、跨请求累计。
 *
 * 会计规则：
 * - `recordEstimate` 把一次请求的粗估记入 `estimatedInput`，并挂起待校准；
 * - `recordUsage` 以供应商 usage 为准，取出最早一笔待校准粗估与之配对，
 *   计算该请求的单次偏差并累进 `estimateError`；实际分项（input/output/
 *   cache…）同步入账——**实际用量以供应商为准，粗估只用于偏差度量，不掺入
 *   实际累计**；
 * - `forgetEstimate` 丢弃最近一笔待校准粗估（请求失败未产生 usage 时由
 *   loop 调用）：失败的请求从未真正消耗，不该计入累计漂移；
 * - `drift()` 汇总累计粗估 vs 实测的偏差，供展示与分词器选型判断；
 * - `snapshot()` / 构造种子 / `rebuild()` 支持跨会话重建（/resume）：
 *   usage 条目持久化在会话日志里，重建后实际分项从历史累计、粗估从零重新
 *   累计（粗估不落盘，见 rebuild 注释）。
 *
 * 每次调用 `runAgentTurn` 传入同一个账本实例即可跨轮次持续累计；loop 缺省
 * 自建并随 TurnResult.budget 返回（runtime/loop.ts）。
 */
export class BudgetLedger {
  private inputTokens: number;
  private outputTokens: number;
  private noCacheTokens: number;
  private cacheReadTokens: number;
  private cacheWriteTokens: number;
  private estimatedInput: number;
  private estimateError: number;
  /**
   * 未校准的粗估队列：recordEstimate 入队、recordUsage 出队配对、
   * forgetEstimate 弹出队尾。请求严格串行（loop 一轮一请求），队列长度
   * 恒为 0 或 1；队列不参与快照（粗估不持久化）。
   */
  private readonly pending: number[] = [];

  /** 以既有账本形态为种子（跨会话重建的另一入口：直接喂 snapshot）。 */
  constructor(initial: Partial<BudgetLedgerState> = {}) {
    this.inputTokens = initial.inputTokens ?? 0;
    this.outputTokens = initial.outputTokens ?? 0;
    this.noCacheTokens = initial.noCacheTokens ?? 0;
    this.cacheReadTokens = initial.cacheReadTokens ?? 0;
    this.cacheWriteTokens = initial.cacheWriteTokens ?? 0;
    this.estimatedInput = initial.estimatedInput ?? 0;
    this.estimateError = initial.estimateError ?? 0;
  }

  /**
   * 请求前粗估入账：记入 estimatedInput 并挂起待校准。
   * 非法值（NaN / 负数）防御性跳过——粗估是尽力而为，不因此打断 loop。
   */
  recordEstimate(estimatedTokens: number): void {
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) return;
    this.estimatedInput += estimatedTokens;
    this.pending.push(estimatedTokens);
  }

  /**
   * 丢弃最近一笔待校准粗估（请求失败未产生 usage 时由 loop 调用）。
   * 队列为空时幂等无操作（防御：该轮 usage 已到达并完成配对）。
   */
  forgetEstimate(): void {
    const estimate = this.pending.pop();
    if (estimate !== undefined) this.estimatedInput -= estimate;
  }

  /**
   * 响应后校准：供应商 usage 为准。
   * - 实际分项（input / output / cache…）全部以 actual 入账，不掺入粗估；
   * - 若有待校准粗估（正常路径恒有），与之配对并累进单次偏差；
   * - 字段缺省（供应商未上报）按 0 计，不因此丢历史累计。
   */
  recordUsage(actual: UsageData): void {
    this.inputTokens += actual.inputTokens ?? 0;
    this.outputTokens += actual.outputTokens ?? 0;
    this.noCacheTokens += actual.noCacheTokens ?? 0;
    this.cacheReadTokens += actual.cacheReadTokens ?? 0;
    this.cacheWriteTokens += actual.cacheWriteTokens ?? 0;

    const estimate = this.pending.shift();
    if (estimate !== undefined) {
      this.estimateError += estimate - (actual.inputTokens ?? 0);
    }
  }

  /** 粗估 vs 实测偏差（累计；供 T-063 展示与分词器选型判断）。 */
  drift(): TokenDrift {
    const actual = this.inputTokens;
    return {
      estimated: this.estimatedInput,
      actual,
      error: this.estimateError,
      rate: actual === 0 ? 0 : this.estimateError / actual,
    };
  }

  /**
   * 累计缓存命中率（T-071 命中率上报）：cacheRead / (cacheRead + noCache)，
   * 0~1。对供应商上报过缓存分项的请求按累计口径计算——压缩（T-070）改写摘要
   * 块后，该块从 cacheRead 转为 cacheWrite / noCache，累计命中率随之下降，
   * 反映「稳定前缀变化」；没有任何缓存分项上报时返回 undefined。
   */
  cacheHitRate(): number | undefined {
    const total = this.cacheReadTokens + this.noCacheTokens;
    if (total <= 0) return undefined;
    return this.cacheReadTokens / total;
  }

  /** 当前账本快照（跨会话重建 / 序列化 / 状态栏种子的载体）。 */
  snapshot(): BudgetLedgerState {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      noCacheTokens: this.noCacheTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      estimatedInput: this.estimatedInput,
      estimateError: this.estimateError,
    };
  }

  /**
   * 从会话 usage 条目重建账本（/resume：跨会话累计实际分项）。
   *
   * 会话日志（session/log.ts 的 usage 条目）只持久化了供应商的实际用量；
   * 请求前粗估不落盘（0.6.0 不为此扩展日志格式），因此重建后
   * `estimatedInput` / `estimateError` 从零重新累计——drift 是「本段会话
   * 运行期」的诊断，而非全生命周期。需要历史粗估时（未来版本）应把估算值
   * 一并写入日志条目，此接口签名不变。
   */
  static rebuild(usageEntries: readonly UsageData[]): BudgetLedger {
    const ledger = new BudgetLedger();
    for (const entry of usageEntries) ledger.recordUsage(entry);
    return ledger;
  }
}
