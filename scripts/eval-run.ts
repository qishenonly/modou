/**
 * G-0.9.0 评测运行脚本：用真实 provider（opencode 套餐）跑评测子集，
 * 聚合五项度量并输出报告。
 *
 * 0.15.0 起注入技能：从本仓库发现内置技能（+ 当前用户/项目技能），以
 * RunEvalOptions.skills 装配 skill 工具与系统提示词技能清单——技能触发任务
 * （skill-code-review）在真实模型下可测「触发准确率」。
 *
 * 用法：bun --env-file=.env scripts/eval-run.ts [taskId...]
 */
import { homedir } from 'node:os';
import { createProviderFromEnv } from '../packages/core/src/provider/providers';
import { runSuite } from '../packages/core/src/eval/runner';
import { formatSuiteReport } from '../packages/core/src/eval/report';
import { findTask } from '../packages/core/src/eval/tasks';
import { discoverSkills } from '../packages/core/src/skills/discover';

const ids =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [
        'fix-average',
        'feature-format-bytes',
        'refactor-pricing-round',
        'read-fibonacci-zero',
        'skill-code-review',
      ];

const tasks = ids.map((id) => {
  const t = findTask(id);
  if (t === undefined) throw new Error(`未知任务：${id}`);
  return t;
});

const provider = createProviderFromEnv('openai-compat');
console.error(`provider: ${provider.id} / ${provider.modelId}`);
console.error(`tasks: ${ids.join(', ')}\n`);

// 0.15.0：三级发现（内置 < 全局 < 项目）后把 name/description/body 注入评测——
// 装配 skill 工具（模型可调用）与系统提示词技能清单（渐进式披露）。目录字段
// 一并带上（skill 工具注入正文时给出出处）。
const discoveredSkills = discoverSkills({
  homeDir: homedir(),
  projectRoot: process.cwd(),
});
console.error(`skills: ${discoveredSkills.map((s) => s.name).join(', ')}\n`);
const skills = discoveredSkills.map((skill) => ({
  name: skill.name,
  description: skill.description,
  body: skill.body,
  directory: skill.directory,
  files: skill.files,
  allowedTools: skill.allowedTools,
}));

const suite = await runSuite({
  tasks,
  provider: () => provider,
  run: { skills },
});

console.log(formatSuiteReport(suite));
