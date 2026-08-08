/**
 * Hooks（0.14.0，design 002 5.1 管线 ④⑦ 挂载点 + 生命周期扩展点）。
 *
 * 确定性脚本介入 agent 生命周期：总线（T-140 bus.ts）按钩子点 + 工具匹配器
 * 注册 / 执行；执行器（T-141 executor.ts）跑外部进程（JSON stdin/stdout +
 * 超时 + 失败降级 + 执行日志）；聚合函数（T-142 run.ts）把结果翻译成管线
 * 语义（deny 阻止 + 理由回喂 / 参数改写 / 提交注入与阻止）。
 */
export * from './types';
export * from './bus';
export * from './executor';
export * from './log';
export * from './run';
export * from './config';
