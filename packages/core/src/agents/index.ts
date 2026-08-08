/**
 * 自定义 agents 模块（0.17.0 T-170，design 002 十节扩展点表：
 * 自定义 agents = Config 加载 + 复用子代理运行时派发）。
 *
 * - parse.ts：`.modou/agents/*.md` 解析（frontmatter + 角色正文，复用
 *   config/commands 的 frontmatter 解析）；
 * - discover.ts：两级发现与加载（全局 ~/.modou/agents/ < 项目
 *   .modou/agents/，项目覆盖全局），发现即解析。
 *
 * 派发（agent 工具 → 子代理运行时）在 runtime/agent.ts 与 tools/impl/agent.ts，
 * 不在此模块（agents 是 Config 扩展点，不依赖 runtime）。
 */
export * from './parse';
export * from './discover';
