/**
 * 系统提示词模块（T-023）。
 * 只读 Agent 的系统提示词：身份与行为准则、搜索优先策略、工具说明
 * （由 ToolRegistry 动态生成）、输出期待。
 */
export { default, buildSystemPrompt } from './system';
export type { BuildSystemPromptOptions } from './system';
