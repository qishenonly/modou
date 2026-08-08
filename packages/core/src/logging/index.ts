/**
 * 结构化日志（T-131 CI 友好化）：JSONL 追加写，含每次请求 token 分项 /
 * 工具调用 / 权限裁决。落 `~/.modou/logs/`，与对话的会话日志（session/）
 * 分开——前者记「系统做了什么决定」，后者记「对话发生了什么」。
 */
export { StructuredLogger, EnvelopeLogAdapter } from './structured';
export type {
  StructuredLogEntry,
  RequestLogEntry,
  ToolLogEntry,
  PermissionLogEntry,
  StructuredLoggerOptions,
  EnvelopeLogAdapterMeta,
} from './structured';
export {
  defaultStructuredLogDir,
  defaultStructuredLogFilename,
} from './structured';
