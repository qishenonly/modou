/**
 * 技能模块（0.15.0 Skills，design 002 §10 扩展点表「Skills = Config 发现 +
 * Context 投影时按需注入正文」）。
 *
 * - parse.ts（T-150）：SKILL.md 解析——frontmatter（name / description /
 *   可选 allowed-tools）+ 正文，严格遵循 Agent Skills 开放标准（skills.sh）；
 * - discover.ts（T-151）：三级发现——仓库内置 skills/ < ~/.modou/skills 全局
 *   < <project>/.modou/skills 项目（后者覆盖前者）。
 *
 * 依赖方向：只依赖 node 内建与 tools/types（Skill 工具在 tools/impl 内，
 * 通过 SkillInfo 结构接口与 skills 解耦），不依赖 runtime / provider。
 */
export * from './parse';
export * from './discover';
