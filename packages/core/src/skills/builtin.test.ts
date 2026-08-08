/**
 * 内置技能首批（T-153）测试。
 *
 * 覆盖（0.15.0-kickoff T-153）：
 * - 四个内置技能（代码审查 / 写测试 / 写 commit message / 调试排查）经
 *   discoverSkills（缺省内置目录 = 仓库 skills/）全部可发现，frontmatter 的
 *   name / description / allowed-tools 解析正确、正文非空；
 * - 可注入：skill 工具命中内置技能时注入正文 + 附带文件（错误即数据路径
 *   已在 skill.test.ts 覆盖）。
 *
 * 全部离线：只读仓库内 skills/ 目录，homeDir / projectRoot 用临时目录隔离
 * （不读写用户真实 ~/.modou）。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillTool } from '../tools/impl/skill';
import { defaultBuiltinSkillsDir, discoverSkills } from './discover';

/** 四个内置技能名（与 skills/ 目录一一对应）。 */
const BUILTIN_NAMES = [
  'code-review',
  'write-tests',
  'commit-message',
  'debugging',
];

describe('内置技能首批（T-153）', () => {
  test('四个内置技能全部可发现：name / description / allowed-tools / 正文', () => {
    const home = mkdtempSync(join(tmpdir(), 'modou-builtin-home-'));
    const project = mkdtempSync(join(tmpdir(), 'modou-builtin-project-'));
    try {
      const discovered = discoverSkills({
        homeDir: home,
        projectRoot: project,
        builtinDir: defaultBuiltinSkillsDir(),
      });

      const names = discovered.map((s) => s.name).sort();
      // 至少包含四个内置技能（仓库 skills/ 可能还有未来的内置，不断言恰等于）
      for (const builtin of BUILTIN_NAMES) {
        expect(names).toContain(builtin);
      }

      const codeReview = discovered.find((s) => s.name === 'code-review');
      expect(codeReview?.level).toBe('builtin');
      expect(codeReview?.description.length).toBeGreaterThan(0);
      // allowed-tools 解析（标准块状列表）
      expect(codeReview?.allowedTools).toContain('read');
      // 正文非空
      expect(codeReview?.body.length).toBeGreaterThan(50);
      // 正文确实描述了流程（抽查关键句）
      expect(codeReview?.body).toContain('先看 diff 全貌');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('内置技能可注入：skill 工具命中返回正文 + 附带文件清单', async () => {
    const home = mkdtempSync(join(tmpdir(), 'modou-builtin-inject-home-'));
    const project = mkdtempSync(
      join(tmpdir(), 'modou-builtin-inject-project-'),
    );
    try {
      const discovered = discoverSkills({
        homeDir: home,
        projectRoot: project,
        builtinDir: defaultBuiltinSkillsDir(),
      });
      const index = new Map(discovered.map((s) => [s.name, s] as const));
      const tool = createSkillTool({
        resolve: (name) => index.get(name),
        names: () => [...index.keys()],
      });

      const outcome = await tool.execute(
        { name: 'write-tests' },
        { signal: new AbortController().signal },
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.forModel).toContain('# 技能：write-tests');
      expect(outcome.forModel).toContain('按三明治结构');
      expect(outcome.forModel).toContain('红 → 绿 → 补');

      const debugging = await tool.execute(
        { name: 'debugging' },
        { signal: new AbortController().signal },
      );
      expect(debugging.ok).toBe(true);
      expect(debugging.forModel).toContain('复现');
      expect(debugging.forModel).toContain('缩小范围');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('内置技能与全局/项目同名的覆盖仍生效（全局覆盖内置）', () => {
    const home = mkdtempSync(join(tmpdir(), 'modou-builtin-ovr-home-'));
    const project = mkdtempSync(join(tmpdir(), 'modou-builtin-ovr-project-'));
    try {
      // 全局层放一个同名 code-review（覆盖内置）
      const globalSkillDir = join(home, '.modou', 'skills', 'code-review');
      mkdirSync(globalSkillDir, { recursive: true });
      writeFileSync(
        join(globalSkillDir, 'SKILL.md'),
        '---\nname: code-review\ndescription: 全局定制的代码审查\n---\n# 全局正文',
      );

      const discovered = discoverSkills({
        homeDir: home,
        projectRoot: project,
        builtinDir: defaultBuiltinSkillsDir(),
      });
      const codeReview = discovered.find((s) => s.name === 'code-review');
      expect(codeReview?.level).toBe('global');
      expect(codeReview?.description).toBe('全局定制的代码审查');
      expect(codeReview?.body).toContain('全局正文');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});
