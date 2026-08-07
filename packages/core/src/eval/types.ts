import type { CompactOptions } from '../context/compact';

/**
 * 评测任务类型（T-090 四类）：修 bug / 加功能 / 重构（行为不变断言）/
 * 读代码答问。
 */
export type EvalTaskKind = 'fix' | 'feature' | 'refactor' | 'read';

/**
 * 评测任务判定上下文：judge 拿到的全部信息。
 * - `dir`：临时工作目录（fixture 副本根，模型在此目录里干活）；
 * - `text`：模型最终文本输出（读代码答问类任务据此判定）；
 * - `task`：任务定义本身（judge 可能需要参考 prompt / fixture 名）。
 */
export interface JudgeContext {
  readonly dir: string;
  readonly text: string;
  readonly task: EvalTask;
}

/** 判定结果：通过 + 理由（供度量采集与调试留档）。 */
export interface JudgeResult {
  readonly pass: boolean;
  readonly reason: string;
}

/**
 * 一条评测任务（可自动判定）。
 *
 * `judge` 是纯函数：给定目录 + 模型输出，判定通过 / 失败，不依赖外部状态。
 * 因此评测测试可「手工断言 judge 判定」离线驱动（T-035 离线验证方式）。
 * judge 内置三种判定原语（judges.ts）：
 * - 运行测试断言通过（修 bug：`bun test tests/<bug>.test.ts` 退出码 0）；
 * - grep 断言文件含某内容 + 探针测试断言行为（加功能）；
 * - 关键词 / 结构断言模型文本输出（读代码答问）。
 */
export interface EvalTask {
  /** 任务唯一 id（如 fix-average）。 */
  readonly id: string;
  /** 任务类型：fix / feature / read。 */
  readonly kind: EvalTaskKind;
  /** 给人看的一句话说明（评测报告用）。 */
  readonly title: string;
  /** 给模型的指令（作为用户消息首条）。 */
  readonly prompt: string;
  /** 使用的 fixture 目录名（fixtures/<name>，运行前复制到临时目录）。 */
  readonly fixture: string;
  /** 判定器：根据模型产出判定通过 / 失败。 */
  readonly judge: (ctx: JudgeContext) => Promise<JudgeResult> | JudgeResult;
  /** 轮次上限（缺省 10）。 */
  readonly maxTurns?: number;
  /**
   * 压缩配置（T-070 /compact）：提供时该任务在 loop 中启用增量压缩
   * （长任务压缩用例，验证「压缩后任务延续率」——压缩前后 judge 仍通过）。
   * 未注入 generateDelta 时由 runEval 缺省装配生产摘要生成器
   * （createModelDeltaGenerator，见 runner.ts）；测试可经 RunEvalOptions.compact
   * 整体覆盖注入 stub。
   */
  readonly compact?: CompactOptions;
  /** 是否长任务压缩用例（40+ 轮、触发压缩、压缩后延续率的主要来源）。 */
  readonly long?: boolean;
}
