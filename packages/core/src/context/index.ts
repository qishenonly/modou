/**
 * 上下文模块（design 002 2.2 Context）：从会话日志投影出模型请求、预算核算、
 * 压缩状态维护（002 第十二节目录布局：project / budget / compact / summary）。
 *
 * 依赖方向：Context 只依赖 Session 与 Provider（002 2.2）——预算核算只复用
 * 协议类型（protocol/events），不感知 provider / runtime 内部。
 *
 * 0.6.0 落地 budget（T-062）与 project 分项估算（T-063 /context）；
 * 0.7.0 落地 summary（T-070：增量压缩的持久摘要状态）、compact
 * （压缩决策 / 投影 / /compact 驱动）与 delta（生产摘要增量生成）。
 */
export * from './budget';
export * from './project';
export * from './summary';
export * from './compact';
export * from './delta';
