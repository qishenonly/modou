/**
 * 评测子系统（T-035：评测集骨架）。
 *
 * fixture 仓库 + 首批 10 个任务（修 bug / 加功能 / 读代码答问），可自动判定。
 * 0.3.0 骨架先跑通离线 stub 用例（runEval 可注入 provider）；真实模型评测与
 * 度量总览留 0.9.0（T-090 / T-091）。
 */
export * from './types';
export * from './metrics';
export * from './judges';
export * from './fixtures';
export * from './tasks';
export * from './runner';
