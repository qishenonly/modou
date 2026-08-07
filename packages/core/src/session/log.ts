/**
 * 会话日志（design 002 §4.1 / §4.2 的 0.6.0 子集，T-060）。
 *
 * 会话日志是「唯一真相」：追加写、不可变、完整。它记下发生过的一切——
 * 用户说了什么、模型回了什么、调了哪些工具、结果是什么、每次请求的 token
 * 用量、轮次的起止。持久化为 JSONL（用户侧布局 002 §12）：
 *
 *     <homeDir>/.modou/sessions/<project-hash>/<session-id>.jsonl
 *
 * 它**永远不被裁剪**；上下文（Context）是它的投影，/resume（T-061）与压缩
 * （0.7.0）都只读它。
 *
 * 记录形态：`{ seq, ts, kind, data }`。kind 为 002 §4.2 Entry 的子集
 * （user / assistant / tool_result / notice / compaction / model_switch），
 * 另加过程性条目 turn_start / turn_end / usage / error。seq 从 1 单调递增
 * （会话重开时续读既有最大 seq），ts 为 epoch ms（可注入时钟）。
 *
 * 写入语义：
 * - 只追加不重写、不裁剪；内部串行写队列保证并发 append 的文件顺序与
 *   seq 顺序一致；
 * - 写失败经 onError 报告（缺省 stderr，不静默），**不抛出**——日志是 agent
 *   循环的旁路记录，不得因日志写失败打断任务；
 * - 项目哈希取 cwd 的稳定哈希（先 realpath 归一，再 SHA-256 前 16 位），
 *   同一工作目录恒映射到同一会话目录。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AttachmentRef,
  NoticeLevel,
  TurnEndTermination,
} from '../protocol';

// ---------------------------------------------------------------------------
// 条目类型（002 §4.2 Entry 的 0.6.0 子集）
// ---------------------------------------------------------------------------

/** user 条目负载：用户输入文本（可选附件；复用协议 submit 的 AttachmentRef）。 */
export interface UserEntryData {
  readonly text: string;
  readonly attachments?: readonly AttachmentRef[];
}

/** assistant 条目的工具调用（id / name / 入参；入参已脱敏，见 loop 接线）。 */
export interface AssistantCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** assistant 条目负载：本轮文本（可为空串）+ 推理（可选）+ 工具调用（可选）。 */
export interface AssistantEntryData {
  readonly text: string;
  readonly thinking?: string;
  readonly calls?: readonly AssistantCall[];
}

/** tool_result 条目负载：一次工具执行的结果（forModel 回喂模型 / payload 给人）。 */
export interface ToolResultEntryData {
  readonly callId: string;
  readonly ok: boolean;
  readonly forModel: string;
  /** 给人看的结果摘要（管线 Normalize 填写，缺省取 forModel 首行）。 */
  readonly summary?: string;
  /** 结构化载荷（如 diff），前端可渲染得更好。 */
  readonly payload?: unknown;
}

/**
 * usage 条目负载：一次模型请求的 token 分项（与 provider TokenUsage 同形）。
 * `cacheHitRate`（T-071）为单次请求命中率，供应商上报了缓存分项才存在；
 * /resume 重建账本（BudgetLedger.rebuild）仍以 cacheRead/noCache 累计为准。
 */
export interface UsageEntryData {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly noCacheTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheHitRate?: number;
}

/** turn_start 条目负载：轮次号。 */
export interface TurnStartEntryData {
  readonly turn: number;
}

/** turn_end 条目负载：轮次号 + 终止原因（复用协议 turn_end 的 TurnEndTermination）。 */
export interface TurnEndEntryData {
  readonly turn: number;
  readonly termination: TurnEndTermination;
}

/** notice 条目负载：级别 + 文本（级别复用协议 NoticeLevel；配置告警、指令截断…）。 */
export interface NoticeEntryData {
  readonly level: NoticeLevel;
  readonly text: string;
}

/** error 条目负载：错误分类、是否可恢复、面向用户的说明（与协议 ErrorData 同形）。 */
export interface ErrorEntryData {
  readonly category: 'provider' | 'internal';
  readonly kind: string;
  readonly recoverable: boolean;
  readonly message: string;
}

/**
 * compaction 条目负载（design 002 §4.2：压缩事件入日志；0.7.0 落地）。
 * - `covers`：被折叠的轮次范围（当前线程的轮次序号，1-based）；
 * - `summaryRev`：压缩后的摘要版本号；
 * - `state`：压缩后的完整摘要状态快照（T-070 扩展落盘字段）——/resume
 *   （T-070：从日志 compaction 条目重建）据此恢复持久摘要状态，无需重放
 *   全量历史。状态的结构校验在 context/summary.ts 的 isSummaryState /
 *   rebuildSummaryState（本模块不自知 SummaryState，落盘为 unknown）。
 */
export interface CompactionEntryData {
  readonly covers: readonly [number, number];
  readonly summaryRev: number;
  readonly state?: unknown;
}

/** model_switch 条目负载（design 002 §4.2：会话中途换模型入日志；0.8.0 落地）。 */
export interface ModelSwitchEntryData {
  /** 切换前的模型 ID。 */
  readonly from: string;
  /** 切换后的模型 ID。 */
  readonly to: string;
}

/** kind → data 的类型映射（判别联合的单一来源）。 */
export interface SessionEntryDataMap {
  user: UserEntryData;
  assistant: AssistantEntryData;
  tool_result: ToolResultEntryData;
  usage: UsageEntryData;
  turn_start: TurnStartEntryData;
  turn_end: TurnEndEntryData;
  notice: NoticeEntryData;
  error: ErrorEntryData;
  compaction: CompactionEntryData;
  model_switch: ModelSwitchEntryData;
}

export type SessionEntryKind = keyof SessionEntryDataMap;

/** 已知条目种类（供运行时校验读入的记录）。 */
const SESSION_ENTRY_KINDS: readonly SessionEntryKind[] = [
  'user',
  'assistant',
  'tool_result',
  'usage',
  'turn_start',
  'turn_end',
  'notice',
  'error',
  'compaction',
  'model_switch',
];

const SESSION_ENTRY_KIND_SET: ReadonlySet<string> = new Set(
  SESSION_ENTRY_KINDS,
);

/**
 * 一条会话记录：公共字段 seq / ts + 按 kind 判别的负载。
 * JSONL 每行一条，序列化形态为 `{ seq, ts, kind, data }`。
 */
export type SessionRecord = {
  readonly seq: number;
  readonly ts: number;
} & (
  | { readonly kind: 'user'; readonly data: UserEntryData }
  | { readonly kind: 'assistant'; readonly data: AssistantEntryData }
  | { readonly kind: 'tool_result'; readonly data: ToolResultEntryData }
  | { readonly kind: 'usage'; readonly data: UsageEntryData }
  | { readonly kind: 'turn_start'; readonly data: TurnStartEntryData }
  | { readonly kind: 'turn_end'; readonly data: TurnEndEntryData }
  | { readonly kind: 'notice'; readonly data: NoticeEntryData }
  | { readonly kind: 'error'; readonly data: ErrorEntryData }
  | { readonly kind: 'compaction'; readonly data: CompactionEntryData }
  | { readonly kind: 'model_switch'; readonly data: ModelSwitchEntryData }
);

/**
 * 运行时结构守卫：判断一个值是否合法的会话记录。
 * 浅校验（seq/ts 为数字、kind 在已知集合、data 为对象）；深度字段不在此
 * 证明，读方（SessionStore）以乐观类型使用。
 */
export function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    seq?: unknown;
    ts?: unknown;
    kind?: unknown;
    data?: unknown;
  };
  return (
    typeof candidate.seq === 'number' &&
    typeof candidate.ts === 'number' &&
    typeof candidate.kind === 'string' &&
    SESSION_ENTRY_KIND_SET.has(candidate.kind) &&
    typeof candidate.data === 'object' &&
    candidate.data !== null
  );
}

// ---------------------------------------------------------------------------
// 项目哈希与会话 ID
// ---------------------------------------------------------------------------

/**
 * 项目哈希：cwd 的稳定哈希（同一工作目录恒映射同一会话目录）。
 * 先 realpath 归一（跟随符号链接、解析 ..），再 SHA-256 取前 16 位十六进制；
 * 目录不存在等异常场景退回原始路径字符串（对同一入参仍稳定）。
 */
export function projectHash(cwd: string): string {
  const normalized = normalizeCwd(cwd);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function normalizeCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** 默认会话 ID：`YYYYMMDD-HHmmss-<随机6>`（时间戳+随机，天然按时间排序）。 */
function defaultSessionId(now: number): string {
  const date = new Date(now);
  const pad = (value: number, width = 2): string =>
    String(value).padStart(width, '0');
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(
    date.getDate(),
  )}`;
  const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(
    date.getSeconds(),
  )}`;
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${ymd}-${hms}-${random}`;
}

// ---------------------------------------------------------------------------
// SessionLog
// ---------------------------------------------------------------------------

/** 会话日志构造选项。 */
export interface SessionLogOptions {
  /**
   * 用户主目录：会话根为 `<homeDir>/.modou/sessions`（缺省 os.homedir()）。
   * 测试注入临时目录，避免写真实主目录。
   */
  readonly homeDir?: string;
  /** 项目工作目录：项目哈希的来源（缺省 process.cwd()）。 */
  readonly cwd?: string;
  /** 会话 ID（缺省 `YYYYMMDD-HHmmss-<随机6>`）。 */
  readonly sessionId?: string;
  /** 时钟注入口（测试用；缺省 Date.now）。 */
  readonly now?: () => number;
  /**
   * 写失败处理器：每条记录写入失败时调用（缺省 stderr——不静默）；
   * 调用后 append 正常返回，不抛出（日志是旁路记录）。
   */
  readonly onError?: (error: SessionLogError) => void;
}

/** 会话日志写入失败的诊断错误（经 onError 派发，不抛出）。 */
export class SessionLogError extends Error {
  readonly path: string;
  readonly seq: number;
  readonly kind: SessionEntryKind;
  readonly underlying: unknown;

  constructor(options: {
    path: string;
    seq: number;
    kind: SessionEntryKind;
    underlying: unknown;
  }) {
    const detail =
      options.underlying instanceof Error
        ? options.underlying.message
        : String(options.underlying);
    super(
      `会话日志写入失败（${options.kind}#${options.seq}，${options.path}）：${detail}`,
    );
    this.name = 'SessionLogError';
    this.path = options.path;
    this.seq = options.seq;
    this.kind = options.kind;
    this.underlying = options.underlying;
  }
}

/**
 * 会话日志：JSONL 追加写入器。
 *
 * 用法（loop 接线）：调用方（TUI / headless）按会话构造一个 SessionLog 传入
 * `runAgentTurn({ session })`；loop 在每轮把 user / assistant / tool_result /
 * usage / turn_start / turn_end 追加进来（旁路记录，不影响事件流与返回值）。
 */
export class SessionLog {
  /** 会话 ID（构造时固定）。 */
  readonly sessionId: string;
  /** 会话目录：`<homeDir>/.modou/sessions/<project-hash>`。 */
  readonly dir: string;
  /** 日志文件：`dir/<session-id>.jsonl`。 */
  readonly path: string;

  private readonly clock: () => number;
  private readonly onError: (error: SessionLogError) => void;
  /** 最近一条记录的 seq（0 = 空日志；并发 append 时同步推进，保证 seq 不重复）。 */
  private lastSeq: number;
  /** 串行写队列：保证并发 append 的文件顺序与 seq 顺序一致。 */
  private writeChain: Promise<void>;

  constructor(options: SessionLogOptions = {}) {
    const home = options.homeDir ?? homedir();
    const cwd = options.cwd ?? process.cwd();
    this.clock = options.now ?? (() => Date.now());
    this.sessionId = options.sessionId ?? defaultSessionId(this.clock());
    // 与 store.ts 的 assertSafeToken 同款安全姿态：注入的 sessionId 必须
    // 只含安全字符（拒绝 / 与 ..），防止把日志路径引出 sessions 根。
    if (
      !/^[A-Za-z0-9._-]+$/.test(this.sessionId) ||
      this.sessionId === '.' ||
      this.sessionId === '..'
    ) {
      throw new Error(
        `非法 sessionId "${this.sessionId}"：只允许字母/数字/._-，且不得为 . 或 ..`,
      );
    }
    const project = projectHash(cwd);
    this.dir = join(home, '.modou', 'sessions', project);
    this.path = join(this.dir, `${this.sessionId}.jsonl`);
    this.onError =
      options.onError ??
      ((error) => {
        // 缺省不静默：写失败打到 stderr，调用方可在日志里追查
        console.error(`[modou] ${error.message}`);
      });
    // 会话重开（resume 前奏）：续读既有最大 seq，使追加延续既有编号
    this.lastSeq = readMaxSeqSync(this.path);
    this.writeChain = Promise.resolve();
    // 目录就绪（递归创建）。构造期失败直接抛出——尚未进入 loop，不影响轮次。
    mkdirSync(this.dir, { recursive: true });
  }

  /** 最近一条已记录（或已分配）的 seq（0 = 空日志）。 */
  get seq(): number {
    return this.lastSeq;
  }

  /**
   * 低层追加：写一条 `{ seq, ts, kind, data }`。
   * - seq 同步分配并推进（并发 append 拿到不重复的 seq）；
   * - 写入失败经 onError 报告后正常返回（不抛出）。
   */
  async append<TKind extends SessionEntryKind>(
    kind: TKind,
    data: SessionEntryDataMap[TKind],
  ): Promise<void> {
    const seq = this.lastSeq + 1;
    this.lastSeq = seq;
    try {
      // kind 与 data 的关联由泛型 TKind 保证；JSON.stringify 不要求该对象
      // 具名匹配 SessionRecord 判别联合（运行时记录形态就是这一字面量）。
      await this.serializedWrite(
        `${JSON.stringify({ seq, ts: this.clock(), kind, data })}\n`,
      );
    } catch (underlying) {
      this.onError(
        new SessionLogError({ path: this.path, seq, kind, underlying }),
      );
    }
  }

  /** 追加 user 条目（用户输入）。 */
  appendUser(
    text: string,
    attachments?: readonly AttachmentRef[],
  ): Promise<void> {
    return this.append('user', {
      text,
      ...(attachments !== undefined && attachments.length > 0
        ? { attachments }
        : {}),
    });
  }

  /** 追加 assistant 条目（本轮文本 + 推理 + 工具调用；入参须已脱敏）。 */
  appendAssistant(data: AssistantEntryData): Promise<void> {
    return this.append('assistant', data);
  }

  /** 追加 tool_result 条目（一次工具执行的结果）。 */
  appendToolResult(data: ToolResultEntryData): Promise<void> {
    return this.append('tool_result', data);
  }

  /** 追加 usage 条目（一次模型请求的 token 分项）。 */
  appendUsage(usage: UsageEntryData): Promise<void> {
    return this.append('usage', usage);
  }

  /** 追加 turn_start 条目。 */
  appendTurnStart(turn: number): Promise<void> {
    return this.append('turn_start', { turn });
  }

  /** 追加 turn_end 条目。 */
  appendTurnEnd(turn: number, termination: TurnEndTermination): Promise<void> {
    return this.append('turn_end', { turn, termination });
  }

  /** 追加 notice 条目。 */
  appendNotice(level: NoticeLevel, text: string): Promise<void> {
    return this.append('notice', { level, text });
  }

  /** 追加 error 条目。 */
  appendError(data: ErrorEntryData): Promise<void> {
    return this.append('error', data);
  }

  /**
   * 追加 compaction 条目（T-070：压缩事件入日志）。
   * `state` 为压缩后的完整摘要状态快照（/resume 重建的依据，002 4.2
   * 「日志是唯一真相」——压缩只影响投影，原文仍在，本条只记录压缩史）。
   */
  appendCompaction(data: CompactionEntryData): Promise<void> {
    return this.append('compaction', data);
  }

  /**
   * 追加 model_switch 条目（T-082 /model：会话中途换模型入日志）。
   * /resume 重放日志即可重建正确的模型状态（002 8.2「切换本身作为
   * model_switch 条目入日志」）。投影时该条目被忽略（不产生模型消息），
   * 历史上下文无缝延续。
   */
  appendModelSwitch(from: string, to: string): Promise<void> {
    return this.append('model_switch', { from, to });
  }

  /**
   * 串行追加写入：排队在既有写之后；链上吞掉错误（上层 await 仍可见），
   * 保证一次失败不会让后续记录永久搁浅。
   */
  private serializedWrite(line: string): Promise<void> {
    const task = this.writeChain.then(() =>
      appendFile(this.path, line, 'utf8'),
    );
    this.writeChain = task.catch(() => {});
    return task;
  }
}

/** 读取既有日志文件的最大 seq（文件不存在 / 全坏行时返回 0）。 */
function readMaxSeqSync(path: string): number {
  try {
    let max = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as { seq?: unknown };
        if (typeof parsed.seq === 'number' && parsed.seq > max)
          max = parsed.seq;
      } catch {
        // 坏行跳过：续 seq 不依赖既有内容质量
      }
    }
    return max;
  } catch {
    return 0;
  }
}
