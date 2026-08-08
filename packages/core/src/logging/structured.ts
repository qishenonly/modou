/**
 * 结构化日志（T-131 CI 友好化，design 002 十一「结构化日志（JSONL）」）。
 *
 * 会话日志（session/log.ts）记录「对话发生了什么」；结构化日志记录
 * **「系统做了哪些决定」**——每次模型请求的 token 分项、每次工具调用的
 * 名称与结果、每次权限裁决及其依据。它是排查「为什么它做了这个决定」的
 * 唯一手段，也是评测数据（T-134 /cost）与审计的来源。
 *
 * 形态：JSONL 追加写，落在 `~/.modou/logs/<project-hash>/structured-<日期>.jsonl`。
 * 与 SessionLog 的关系：
 * - 只追加不重写、内部串行写队列保证行序与 seq 顺序一致；
 * - 写失败经 onError 报告（缺省 stderr，不静默），**不抛出**——日志是旁路
 *   记录，不得因日志写失败打断任务；
 * - 默认脱敏：工具入参不进日志（入参脱敏在 loop / 管线已完成，此处只记
 *   名称 / 结果，不记参数）。
 *
 * 驱动方式：`EnvelopeLogAdapter` 消费协议事件流（runAgentTurnJson 收集到的
 * 信封 / TUI 的流式回调都可喂它），按事件类型映射为日志条目：
 * - usage  → request（token 分项 + 模型）；
 * - tool_result → tool_call（工具名来自同 id 的 tool_call，状态来自结果）；
 * - approval_resolved → permission（裁决 + 依据）。
 */

import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Envelope } from '../protocol/events';
import { projectHash } from '../session/log';

// ---------------------------------------------------------------------------
// 条目类型（JSONL 每行一条）
// ---------------------------------------------------------------------------

/** 一次模型请求（usage 事件）：token 分项 + 模型。 */
export interface RequestLogEntry {
  readonly type: 'request';
  /** 注入：写入时由 StructuredLogger 打上 now()，调用方不必给。 */
  readonly ts?: number;
  readonly turn: number;
  readonly agent: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly noCacheTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheHitRate?: number;
}

/** 一次工具调用（tool_result 时刻落盘：名称 + 结果状态）。 */
export interface ToolLogEntry {
  readonly type: 'tool_call';
  /** 注入：写入时由 StructuredLogger 打上 now()，调用方不必给。 */
  readonly ts?: number;
  readonly turn: number;
  readonly agent: string;
  /** 工具调用 ID（与 tool_call 事件的 id 对齐）。 */
  readonly id: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly summary?: string;
}

/** 一次权限裁决（approval_resolved 时刻落盘：裁决 + 依据）。 */
export interface PermissionLogEntry {
  readonly type: 'permission';
  /** 注入：写入时由 StructuredLogger 打上 now()，调用方不必给。 */
  readonly ts?: number;
  readonly turn: number;
  readonly agent: string;
  readonly requestId: string;
  readonly risk: string;
  /** allow_once / allow_always / deny（协议 ApprovalDecision）。 */
  readonly decision: string;
  /** user / rule / policy（协议 approval_resolved 的 source）。 */
  readonly source: string;
  /** 操作描述（如「执行命令：npm run test」）。 */
  readonly operation: string;
}

/** 结构化日志的条目联合（判别联合：type 首字段）。 */
export type StructuredLogEntry =
  RequestLogEntry | ToolLogEntry | PermissionLogEntry;

// ---------------------------------------------------------------------------
// StructuredLogger：JSONL 追加写
// ---------------------------------------------------------------------------

/** StructuredLogger 构造选项。 */
export interface StructuredLoggerOptions {
  /** 日志目录（缺省 `~/.modou/logs/<project-hash>`，由 homeDir + cwd 推导）。 */
  readonly dir?: string;
  /** 文件名（缺省 `structured-<日期>.jsonl`，按天轮转）。 */
  readonly filename?: string;
  /** 写失败上报（缺省 stderr；不静默也不抛出）。 */
  readonly onError?: (error: unknown) => void;
  /** 时钟注入口（测试用；缺省 Date.now）。 */
  readonly now?: () => number;
}

/** 默认日志目录：`~/.modou/logs/<project-hash>`（design 002 十二用户侧布局）。 */
export function defaultStructuredLogDir(
  options: { readonly homeDir?: string; readonly cwd?: string } = {},
): string {
  const home = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  return join(home, '.modou', 'logs', projectHash(cwd));
}

/** 按天轮转的默认文件名：`structured-YYYY-MM-DD.jsonl`。 */
export function defaultStructuredLogFilename(now: number = Date.now()): string {
  const date = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
  return `structured-${ymd}.jsonl`;
}

/**
 * 结构化日志。追加写 JSONL，内部串行写队列保证行序；写失败经 onError 上报，
 * 不打断任务（与 SessionLog 同款旁路语义）。
 */
export class StructuredLogger {
  private readonly file: string;
  private readonly onError: (error: unknown) => void;
  private readonly now: () => number;
  /** 串行写队列：每次 append 接在上一笔之后，保证落盘顺序与调用顺序一致。 */
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: StructuredLoggerOptions = {}) {
    const dir = options.dir ?? defaultStructuredLogDir();
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, options.filename ?? defaultStructuredLogFilename());
    this.onError =
      options.onError ??
      ((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[modou] 结构化日志写失败：${message}`);
      });
    this.now = options.now ?? (() => Date.now());
  }

  /** 当前日志文件路径（测试 / 诊断用）。 */
  get path(): string {
    return this.file;
  }

  /**
   * 追加一条结构化日志条目。调用即排队，返回的 promise 在**该条落盘后** resolve
   * （测试可 await 后读文件断言）。写失败走 onError，不抛出。close 后丢弃新条目。
   */
  append(entry: StructuredLogEntry): Promise<void> {
    // ts 由 logger 注入（now() 注入口），调用方不必给——写入行必有 ts。
    const line = `${JSON.stringify({ ...entry, ts: this.now() })}\n`;
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      try {
        await appendFile(this.file, line, 'utf8');
      } catch (error) {
        this.onError(error);
      }
    });
    return this.queue;
  }

  /** 等待已排队条目全部落盘（测试 / 进程收尾用；幂等）。 */
  async flush(): Promise<void> {
    await this.queue;
  }

  /** 关闭：丢弃后续条目并等待已排队的落盘。 */
  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}

// ---------------------------------------------------------------------------
// EnvelopeLogAdapter：协议事件流 → 日志条目
// ---------------------------------------------------------------------------

/** 适配器需要的事件流附加元信息（模型标识来自调用方持有的 provider）。 */
export interface EnvelopeLogAdapterMeta {
  readonly provider: string;
  readonly model: string;
}

/**
 * 把协议事件流映射为结构化日志条目。
 *
 * - usage 事件 → request 条目（token 分项 + provider/model 元信息）；
 * - tool_call 事件 → 暂存 id→name，tool_result 到达时落 tool_call 条目
 *   （工具名与状态在同一时刻齐全——JSONL 只追加，不做行内更新）；
 * - approval_request 事件 → 暂存 id→operation，approval_resolved 到达时落
 *   permission 条目（裁决 + 依据）。
 *
 * 由调用方把每个信封喂给 `consume`（runAgentTurnJson 的收集回调 / TUI 的
 * 流式回调）。未匹配的事件类型直接跳过（非错误）。
 */
export class EnvelopeLogAdapter {
  private readonly pendingToolNames = new Map<string, string>();
  private readonly pendingOperations = new Map<string, string>();
  private readonly pendingRisks = new Map<string, string>();
  private readonly pendingTurns = new Map<string, number>();
  private readonly pendingAgents = new Map<string, string>();

  constructor(
    private readonly logger: StructuredLogger,
    private readonly meta: EnvelopeLogAdapterMeta,
  ) {}

  /** 消费一个协议信封：按类型映射为日志条目（异步落盘，不阻塞调用方）。 */
  consume(envelope: Envelope): void {
    switch (envelope.type) {
      case 'usage': {
        void this.logger.append({
          type: 'request',
          turn: envelope.turn,
          agent: envelope.agent,
          provider: this.meta.provider,
          model: this.meta.model,
          inputTokens: envelope.data.inputTokens,
          outputTokens: envelope.data.outputTokens,
          noCacheTokens: envelope.data.noCacheTokens,
          cacheReadTokens: envelope.data.cacheReadTokens,
          cacheWriteTokens: envelope.data.cacheWriteTokens,
          cacheHitRate: envelope.data.cacheHitRate,
        });
        break;
      }
      case 'tool_call': {
        this.pendingToolNames.set(envelope.data.id, envelope.data.name);
        break;
      }
      case 'tool_result': {
        const tool = this.pendingToolNames.get(envelope.data.id) ?? 'unknown';
        this.pendingToolNames.delete(envelope.data.id);
        void this.logger.append({
          type: 'tool_call',
          turn: envelope.turn,
          agent: envelope.agent,
          id: envelope.data.id,
          tool,
          ok: envelope.data.ok,
          ...(envelope.data.summary !== undefined
            ? { summary: envelope.data.summary }
            : {}),
        });
        break;
      }
      case 'approval_request': {
        this.pendingOperations.set(envelope.data.id, envelope.data.description);
        this.pendingRisks.set(envelope.data.id, envelope.data.risk);
        this.pendingTurns.set(envelope.data.id, envelope.turn);
        this.pendingAgents.set(envelope.data.id, envelope.agent);
        break;
      }
      case 'approval_resolved': {
        const operation =
          this.pendingOperations.get(envelope.data.id) ?? '未知操作';
        const risk = this.pendingRisks.get(envelope.data.id) ?? 'unknown';
        const turn = this.pendingTurns.get(envelope.data.id) ?? envelope.turn;
        const agent =
          this.pendingAgents.get(envelope.data.id) ?? envelope.agent;
        this.pendingOperations.delete(envelope.data.id);
        this.pendingRisks.delete(envelope.data.id);
        this.pendingTurns.delete(envelope.data.id);
        this.pendingAgents.delete(envelope.data.id);
        void this.logger.append({
          type: 'permission',
          turn,
          agent,
          requestId: envelope.data.id,
          risk,
          decision: envelope.data.decision,
          source: envelope.data.source,
          operation,
        });
        break;
      }
      default:
        break;
    }
  }
}
