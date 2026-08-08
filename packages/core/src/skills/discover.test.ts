/**
 * 技能三级发现（T-151）离线测试。
 *
 * 覆盖（0.15.0-kickoff 3.2 / 002 十二节布局）：
 * - 三级：仓库内置 skills/ < 全局 ~/.modou/skills < 项目 <project>/.modou/skills，
 *   每一级都能被找到、附带文件与正文被正确加载；
 * - 同名覆盖：项目覆盖全局、全局覆盖内置（后者覆盖前者），正文 / 描述随层级变；
 * - 容错：某级目录不存在时跳过、无 SKILL.md 的目录不是技能、隐藏目录跳过、
 *   结果按名排序、frontmatter 缺 name 回落目录名。
 *
 * 全部离线：内置技能目录用临时目录注入（不依赖仓库 skills/ 的真实内容），
 * homeDir / projectRoot 用临时目录隔离。
 */
import { describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultBuiltinSkillsDir,
  discoverSkills,
  findBuiltinSkillsDir,
  type DiscoveredSkill,
} from './discover';

/** 在临时目录里建一个技能：`<dir>/<skillName>/SKILL.md`，返回技能目录。 */
function makeSkill(
  dir: string,
  skillName: string,
  frontmatter: string,
  body: string,
  extra?: (skillDir: string) => void,
): string {
  const skillDir = join(dir, skillName);
  mkdirSync(skillDir, { recursive: true });
  // frontmatter 参数需自带闭合 `---`（与 parse 的输入口径一致）
  writeFileSync(join(skillDir, 'SKILL.md'), `${frontmatter}${body}`);
  extra?.(skillDir);
  return skillDir;
}

describe('discoverSkills（三级发现与同名覆盖）', () => {
  test('三级各自发现：内置 / 全局 / 项目的技能都在结果里，带层级与附带文件', () => {
    const builtin = mkdtempSync(join(tmpdir(), 'modou-skill-builtin-'));
    const globalDir = mkdtempSync(join(tmpdir(), 'modou-skill-global-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'modou-skill-project-'));
    try {
      // 内置：只有这一个技能（代码审查）
      makeSkill(
        builtin,
        'code-review',
        '---\nname: code-review\ndescription: 内置的代码审查技能\n---\n',
        '# 代码审查\n\n逐文件审查。',
      );
      // 全局：写测试（全局层 = homeDir/.modou/skills）
      const globalSkillsDir = join(globalDir, '.modou', 'skills');
      makeSkill(
        globalSkillsDir,
        'write-tests',
        '---\nname: write-tests\ndescription: 全局的写测试技能\n---\n',
        '# 写测试\n\n按三明治写。',
        (skillDir) => {
          const scripts = join(skillDir, 'scripts');
          mkdirSync(scripts, { recursive: true });
          writeFileSync(join(scripts, 'helper.sh'), '#!/bin/sh\n');
        },
      );
      // 项目：调试排查（项目层 = projectRoot/.modou/skills）
      makeSkill(
        join(projectDir, '.modou', 'skills'),
        'debugging',
        '---\nname: debugging\ndescription: 项目的调试排查技能\n---\n',
        '# 调试排查\n\n先复现。',
      );

      const discovered = discoverSkills({
        homeDir: globalDir,
        projectRoot: projectDir,
        builtinDir: builtin,
      });

      const names = discovered.map((s) => s.name).sort();
      expect(names).toEqual(['code-review', 'debugging', 'write-tests']);

      const codeReview = discovered.find((s) => s.name === 'code-review');
      expect(codeReview?.level).toBe('builtin');
      expect(codeReview?.description).toBe('内置的代码审查技能');
      expect(codeReview?.body).toContain('逐文件审查');

      const writeTests = discovered.find((s) => s.name === 'write-tests');
      expect(writeTests?.level).toBe('global');
      expect(writeTests?.files).toEqual(['scripts/helper.sh']);
      expect(writeTests?.body).toContain('按三明治写');

      const debugging = discovered.find((s) => s.name === 'debugging');
      expect(debugging?.level).toBe('project');
      expect(debugging?.directory).toBe(
        join(projectDir, '.modou', 'skills', 'debugging'),
      );
    } finally {
      rmSync(builtin, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('同名覆盖：项目覆盖全局、全局覆盖内置（正文随层级换）', () => {
    const builtin = mkdtempSync(join(tmpdir(), 'modou-skill-ovr-builtin-'));
    const globalDir = mkdtempSync(join(tmpdir(), 'modou-skill-ovr-global-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'modou-skill-ovr-project-'));
    try {
      makeSkill(
        builtin,
        'review',
        '---\nname: review\ndescription: 内置版\n---\n',
        '# 内置正文',
      );
      makeSkill(
        join(globalDir, '.modou', 'skills'),
        'review',
        '---\nname: review\ndescription: 全局版\n---\n',
        '# 全局正文',
      );
      makeSkill(
        join(projectDir, '.modou', 'skills'),
        'review',
        '---\nname: review\ndescription: 项目版\n---\n',
        '# 项目正文',
      );
      const discovered = discoverSkills({
        homeDir: globalDir,
        projectRoot: projectDir,
        builtinDir: builtin,
      });

      expect(discovered).toHaveLength(1);
      const review = discovered[0] as DiscoveredSkill;
      expect(review.name).toBe('review');
      // 项目覆盖全局覆盖内置
      expect(review.level).toBe('project');
      expect(review.description).toBe('项目版');
      expect(review.body).toBe('# 项目正文');
    } finally {
      rmSync(builtin, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('同名覆盖的两级情形：无项目层时全局覆盖内置', () => {
    const builtin = mkdtempSync(join(tmpdir(), 'modou-skill-ovr2-builtin-'));
    const globalDir = mkdtempSync(join(tmpdir(), 'modou-skill-ovr2-global-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'modou-skill-ovr2-project-'));
    try {
      makeSkill(
        builtin,
        'fmt',
        '---\nname: fmt\ndescription: 内置\n---\n',
        '内置正文',
      );
      makeSkill(
        join(globalDir, '.modou', 'skills'),
        'fmt',
        '---\nname: fmt\ndescription: 全局\n---\n',
        '全局正文',
      );
      // 项目层目录存在但没有同名技能

      const discovered = discoverSkills({
        homeDir: globalDir,
        projectRoot: projectDir,
        builtinDir: builtin,
      });

      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.level).toBe('global');
      expect(discovered[0]?.description).toBe('全局');
    } finally {
      rmSync(builtin, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('容错：某级目录不存在时跳过，不抛错；无技能时返回空数组', () => {
    const home = mkdtempSync(join(tmpdir(), 'modou-skill-none-home-'));
    const project = mkdtempSync(join(tmpdir(), 'modou-skill-none-project-'));
    const builtin = join(tmpdir(), 'modou-skill-none-builtin-missing');
    try {
      // 三层都不存在
      const none = discoverSkills({
        homeDir: home,
        projectRoot: project,
        builtinDir: builtin,
      });
      expect(none).toEqual([]);

      // 只有项目层存在
      mkdirSync(join(project, '.modou', 'skills'), { recursive: true });
      const onlyProject = discoverSkills({
        homeDir: home,
        projectRoot: project,
        builtinDir: builtin,
      });
      expect(onlyProject).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('容错：无 SKILL.md 的目录与隐藏目录都不是技能', () => {
    const home = mkdtempSync(join(tmpdir(), 'modou-skill-fake-home-'));
    const project = mkdtempSync(join(tmpdir(), 'modou-skill-fake-project-'));
    const builtin = mkdtempSync(join(tmpdir(), 'modou-skill-fake-builtin-'));
    try {
      // 内置层：一个真技能 + 一个无 SKILL.md 的目录 + 一个隐藏目录
      makeSkill(
        builtin,
        'real',
        '---\nname: real\ndescription: r\n---\n',
        '正文',
      );
      mkdirSync(join(builtin, 'no-skill-md'), { recursive: true });
      mkdirSync(join(builtin, '.hidden-skill'), { recursive: true });

      const discovered = discoverSkills({
        homeDir: home,
        projectRoot: project,
        builtinDir: builtin,
      });
      expect(discovered.map((s) => s.name)).toEqual(['real']);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
      rmSync(builtin, { recursive: true, force: true });
    }
  });

  test('frontmatter 缺 name 回落目录名；结果按技能名排序', () => {
    const home = mkdtempSync(join(tmpdir(), 'modou-skill-nm-home-'));
    const project = mkdtempSync(join(tmpdir(), 'modou-skill-nm-project-'));
    const builtin = mkdtempSync(join(tmpdir(), 'modou-skill-nm-builtin-'));
    try {
      // 无 frontmatter（整份即正文），name 回落目录名 zebra / alpha
      makeSkill(builtin, 'zebra', '', '# 无 frontmatter 技能 A');
      makeSkill(builtin, 'alpha', '', '# 无 frontmatter 技能 B');

      const discovered = discoverSkills({
        homeDir: home,
        projectRoot: project,
        builtinDir: builtin,
      });
      // 按名排序：alpha 在前
      expect(discovered.map((s) => s.name)).toEqual(['alpha', 'zebra']);
      expect(discovered[0]?.body).toContain('无 frontmatter 技能 B');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
      rmSync(builtin, { recursive: true, force: true });
    }
  });

  test('defaultBuiltinSkillsDir 指向仓库内 skills/（上四级）', () => {
    // 本模块在 packages/core/src/skills/，上四级 = 仓库根，其 skills/ 即内置目录
    expect(defaultBuiltinSkillsDir().endsWith('/skills')).toBe(true);
    // 该目录应存在（仓库内置 skills/；至少在 dev 工作树下如此）
    expect(statSync(defaultBuiltinSkillsDir()).isDirectory()).toBe(true);
  });

  test('findBuiltinSkillsDir 在 npm 嵌套布局下上退多级找到内置技能（0.15.0 打包修复）', () => {
    // 模拟安装后的嵌套布局：node_modules/modou/node_modules/@modou/core/src/skills/
    // 是 discover.ts 所在位置，内置技能在 node_modules/modou/skills/（相距六级）。
    const root = mkdtempSync(join(tmpdir(), 'modou-skill-nested-'));
    try {
      const modouDir = join(root, 'node_modules', 'modou');
      const coreSkills = join(
        modouDir,
        'node_modules',
        '@modou',
        'core',
        'src',
        'skills',
      );
      mkdirSync(coreSkills, { recursive: true });
      // 沿途的「假 skills」：core 的源码 skills 目录（无 SKILL.md 子目录，
      // 不该被当作内置技能）——对应源码树里 packages/core/src/skills
      writeFileSync(join(coreSkills, 'parse.ts'), '// 占位源码\n');
      // 真实内置技能：node_modules/modou/skills/code-review/SKILL.md
      makeSkill(
        join(modouDir, 'skills'),
        'code-review',
        '---\nname: code-review\ndescription: 内置的代码审查技能\n---\n',
        '# 代码审查\n\n逐文件审查。',
      );
      makeSkill(
        join(modouDir, 'skills'),
        'write-tests',
        '---\nname: write-tests\ndescription: 内置的写测试技能\n---\n',
        '# 写测试\n\n按三明治写。',
      );

      // 从嵌套布局的 discover.ts 所在目录出发，应退到 node_modules/modou/skills
      const builtin = findBuiltinSkillsDir(coreSkills);
      expect(builtin).toBe(join(modouDir, 'skills'));
      expect(statSync(builtin).isDirectory()).toBe(true);

      // 经 discoverSkills 缺省内置目录 = 上述查找结果：两层技能都可发现
      const home = mkdtempSync(join(tmpdir(), 'modou-skill-nested-home-'));
      const project = mkdtempSync(
        join(tmpdir(), 'modou-skill-nested-project-'),
      );
      try {
        const discovered = discoverSkills({
          homeDir: home,
          projectRoot: project,
          builtinDir: builtin,
        });
        expect(discovered.map((s) => s.name).sort()).toEqual([
          'code-review',
          'write-tests',
        ]);
        expect(discovered.every((s) => s.level === 'builtin')).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
