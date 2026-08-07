/**
 * 会话模块（design 002 2.2 Session）：会话日志的追加与持久化、恢复的基础。
 * 0.6.0（T-060）只落地 log.ts（写）与 store.ts（读/管理）；resume.ts（T-061）
 * 与投影（Context）在后续任务落地。
 *
 * 依赖方向：Session 互不依赖 Permission / Config / Provider（002 2.2），
 * 本模块只依赖 node 内置模块与自身。
 */
export * from './log';
export * from './store';
