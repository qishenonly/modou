/**
 * 系统提示词模块（T-023 / T-034）。
 * Agent 系统提示词：身份与行为准则、搜索优先策略、工具说明
 * （由 ToolRegistry 动态生成）、编辑纪律（写 / 执行工具）、输出期待。
 */
export { default, buildSystemPrompt } from './system';
export type { BuildSystemPromptOptions } from './system';
