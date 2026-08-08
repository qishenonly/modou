/**
 * G-0.9.0 评测运行脚本：用真实 provider（opencode 套餐）跑评测子集，
 * 聚合五项度量并输出报告。
 *
 * 用法：bun --env-file=.env scripts/eval-run.ts [taskId...]
 */
import { createProviderFromEnv } from '../packages/core/src/provider/providers';
import { runSuite } from '../packages/core/src/eval/runner';
import { formatSuiteReport } from '../packages/core/src/eval/report';
import { findTask } from '../packages/core/src/eval/tasks';

const ids =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ['fix-average', 'feature-format-bytes', 'refactor-pricing-round', 'read-fibonacci-zero'];

const tasks = ids.map((id) => {
  const t = findTask(id);
  if (t === undefined) throw new Error(`未知任务：${id}`);
  return t;
});

const provider = createProviderFromEnv('openai-compat');
console.error(`provider: ${provider.id} / ${provider.modelId}`);
console.error(`tasks: ${ids.join(', ')}\n`);

const suite = await runSuite({
  tasks,
  provider: () => provider,
});

console.log(formatSuiteReport(suite));
