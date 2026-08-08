import type { EvalSuiteResult } from './runner';

/**
 * 评测可读报告（T-091）：把 runSuite 的聚合结果格式化为给人读的五项指标
 * 总览 + 逐任务明细。
 *
 * 五项指标与 G-0.9.0 阈值（phase-1-mvp §0.9.0）：
 * 1. 任务完成率 ≥ 60%
 * 2. 工具成功率 ≥ 90%
 * 3. 编辑一次命中率 ≥ 85%
 * 4. 压缩后延续率 ≥ 80%
 * 5. token 基线（无阈值，只报告读数——「基线已建立」）
 */

/** G-0.9.0 五项指标阈值（前三项 + 压缩后延续率；token 基线无阈值）。 */
export interface EvalThresholds {
  readonly taskCompletionRate: number;
  readonly toolSuccessRate: number;
  readonly editHitRate: number;
  readonly compactionContinuationRate: number;
}

/** G-0.9.0 验收阈值（phase-1-mvp §0.9.0）。 */
export const G090_THRESHOLDS: EvalThresholds = {
  taskCompletionRate: 0.6,
  toolSuccessRate: 0.9,
  editHitRate: 0.85,
  compactionContinuationRate: 0.8,
};

/** 单个度量的检查结果。 */
export interface MetricCheck {
  readonly label: string;
  readonly value?: number;
  readonly threshold?: number;
  /** true = 达标；false = 不达标；null = 无法计算（分母为零）。 */
  readonly pass: boolean | null;
}

/** 数值格式化：百分比两位小数，未定义显示「—」。 */
function formatPercent(value: number | undefined): string {
  if (value === undefined) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

/** 度量检查：value ≥ threshold 达标；undefined（分母为零）时 pass = null。 */
function checkMetric(
  label: string,
  value: number | undefined,
  threshold: number,
): MetricCheck {
  if (value === undefined) {
    return { label, value: undefined, threshold, pass: null };
  }
  return { label, value, threshold, pass: value >= threshold };
}

/** 检查结果的展示符号：✓ 达标 / ✗ 不达标 / — 无法计算。 */
function checkMark(pass: boolean | null): string {
  if (pass === null) return '—';
  return pass ? '✓' : '✗';
}

/**
 * 把一套评测聚合结果格式化为可读文本（Markdown 风格）：
 * 五项指标总览（含阈值判定）+ 逐任务明细表 + 压缩用例与 token 备注。
 */
export function formatSuiteReport(suite: EvalSuiteResult): string {
  const thresholds = G090_THRESHOLDS;
  const lines: string[] = [];

  lines.push('# modou 评测报告');
  lines.push('');
  lines.push(
    `任务数：${suite.results.length} · 通过：${suite.results.filter((r) => r.pass).length} · ` +
      `总耗时：${(suite.totalDurationMs / 1000).toFixed(1)}s`,
  );
  lines.push('');

  // —— 五项指标总览 ——
  const checks: MetricCheck[] = [
    checkMetric(
      '任务完成率',
      suite.taskCompletionRate,
      thresholds.taskCompletionRate,
    ),
    checkMetric(
      '工具成功率',
      suite.toolSuccessRate,
      thresholds.toolSuccessRate,
    ),
    checkMetric('编辑一次命中率', suite.editHitRate, thresholds.editHitRate),
    checkMetric(
      '压缩后延续率',
      suite.compactionContinuationRate,
      thresholds.compactionContinuationRate,
    ),
  ];
  lines.push('## 五项指标（G-0.9.0）');
  lines.push('');
  lines.push('| 指标 | 实测 | 阈值 | 判定 |');
  lines.push('|---|---|---|---|');
  for (const check of checks) {
    const thresholdText =
      check.threshold === undefined ? '—' : formatPercent(check.threshold);
    lines.push(
      `| ${check.label} | ${formatPercent(check.value)} | ${thresholdText} | ${checkMark(check.pass)} |`,
    );
  }
  const baseline = suite.tokenBaseline;
  lines.push(
    `| token 基线 | ${baseline.totalTokens}（均 ${baseline.avgTokensPerTask.toFixed(0)}/任务，入 ${baseline.totalInputTokens} / 出 ${baseline.totalOutputTokens}） | — | 已建立 |`,
  );
  lines.push('');

  // —— 压缩用例备注 ——
  if (suite.compactionCandidates > 0) {
    lines.push(
      `> 压缩后延续率：${suite.compactionContinuations}/${suite.compactionCandidates} 个触发压缩的任务判定仍通过` +
        `（${suite.results
          .filter((r) => r.metrics.compactions > 0)
          .map((r) => r.task.id)
          .join('、')}）。`,
    );
  } else {
    lines.push(
      '> 本套评测没有任务触发上下文压缩（压缩后延续率无法计算，不参与验收）。',
    );
  }
  lines.push('');

  // —— 逐任务明细 ——
  lines.push('## 逐任务明细');
  lines.push('');
  lines.push(
    '| id | 类型 | 结果 | 轮次 | 工具成功率 | 编辑命中 | 压缩次数 | token |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const result of suite.results) {
    const kindLabel: Record<string, string> = {
      fix: '修bug',
      feature: '加功能',
      refactor: '重构',
      read: '读代码',
      plan: '规划',
    };
    lines.push(
      `| ${result.task.id} | ${kindLabel[result.task.kind] ?? result.task.kind}${result.task.long ? '·长' : ''} | ` +
        `${result.pass ? '✓' : '✗'} | ${result.turns} | ` +
        `${formatPercent(result.metrics.toolSuccessRate)} | ` +
        `${formatPercent(result.metrics.editHitRate)} | ${result.metrics.compactions} | ` +
        `${(result.metrics.usage.inputTokens ?? 0) + (result.metrics.usage.outputTokens ?? 0)} |`,
    );
  }
  lines.push('');

  // —— 判定失败的裁判理由（调试留档） ——
  const failed = suite.results.filter((r) => !r.pass);
  if (failed.length > 0) {
    lines.push('## 失败任务判定理由');
    lines.push('');
    for (const result of failed) {
      lines.push(`- **${result.task.id}**：${result.judge.reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
