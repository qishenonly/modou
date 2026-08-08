/**
 * 快照子系统（design 002 §4.2 snapshot 条目 / §12 用户侧布局 snapshots/，0.10.0「安全网」）。
 *
 * - engine.ts（T-100/T-101/T-102/T-103）：影子 git 快照引擎——快照创建、触碰路径 /
 *   上限策略、列表、回滚预览与还原、清理与占用报告；
 * - touched.ts（T-101）：从会话日志 / 工具调用收集 agent 触碰的文件路径（快照范围）。
 *
 * 依赖方向：只依赖 node 内建模块与 session 的 projectHash；不依赖 provider / runtime /
 * TUI（core 零 UI 依赖由 T-003 守卫）。
 */
export * from './engine';
export * from './touched';
