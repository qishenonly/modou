/**
 * 配置系统（design 002 九节，T-080）：分层配置解析与 schema 校验。
 *
 * 0.8.0 落地 settings.ts（settings.json 全局 + 项目、MODOU_* 环境变量、
 * 显式覆盖，友好 schema 报错）与 instructions.ts（AGENTS.md 三级指令，
 * T-081）：前者是给程序读的结构化设置，后者是给模型读的项目指令，二者分开。
 */
export * from './instructions';
export * from './settings';
export * from './commands';
