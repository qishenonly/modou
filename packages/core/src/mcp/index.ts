/**
 * MCP 客户端模块（0.16.0，T-160~T-163）。
 *
 * - types.ts：JSON-RPC / 传输契约 / MCP 高层域类型（T-160）；
 * - stdio.ts：子进程 stdio 传输（T-160）；
 * - http.ts：Streamable HTTP 传输（T-161，SSE 响应解析）；
 * - client.ts：McpClient——握手 / 能力协商 / tools/list / tools/call（T-160）；
 * - inject.ts：MCP server 工具 → 内部 Tool（命名空间隔离 + schema 转换，T-162）；
 * - manager.ts：server 启停 / 崩溃重连 / 状态（T-163）。
 *
 * 依赖方向：只依赖 node 内建、zod（inject.ts）与本模块内部；不依赖 runtime /
 * provider（002 2.2 Tools 模块的依赖约束）。tools/types 由 inject.ts 单向消费。
 */
export * from './types';
export * from './stdio';
export * from './http';
export * from './client';
export * from './inject';
