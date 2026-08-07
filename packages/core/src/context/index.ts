/**
 * 上下文模块（design 002 2.2 Context）：从会话日志投影出模型请求、预算核算、
 * 压缩状态维护（002 第十二节目录布局：project / budget / compact / summary）。
 *
 * 依赖方向：Context 只依赖 Session 与 Provider（002 2.2）——预算核算只复用
 * 协议类型（protocol/events），不感知 provider / runtime 内部。
 *
 * 0.6.0 只落地 budget（T-062）；project（投影）、compact / summary（压缩，
 * 0.7.0）随后在此目录扩展。
 */
export * from './budget';
