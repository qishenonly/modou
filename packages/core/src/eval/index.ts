/**
 * 评测子系统（T-035 骨架 / T-090 扩充）。
 *
 * fixture 仓库 + 24 个任务（修 bug / 加功能 / 重构 / 读代码答问，含长任务
 * 压缩用例），可自动判定；runSuite 聚合五项度量（任务完成率 / 工具成功率 /
 * 编辑一次命中率 / 压缩后延续率 / token 基线），report.ts 输出可读报告。
 * 真实模型评测（T-093 多供应商回归）注入真实 provider 即可。
 */
export * from './types';
export * from './metrics';
export * from './judges';
export * from './fixtures';
export * from './tasks';
export * from './runner';
export * from './report';
