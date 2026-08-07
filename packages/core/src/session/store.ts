/**
 * 会话存储（design 002 §12 用户侧布局，T-060）：读取与会话文件管理。
 *
 * 会话日志（log.ts）负责「写」，本模块负责「读与管理」：
 * - `projects()`：列出所有含会话的项目哈希目录；
 * - `list(projectHash)`：列出某项目下的会话（按时间倒序——末条记录的 ts
 *   降序，全坏行文件退化为文件 mtime 兜底）；
 * - `read(projectHash, sessionId)`：逐行解析单条会话，坏行跳过并在结果里
 *   标记行号（容忍坏行不静默）；
 * - `delete(projectHash, sessionId)`：删除会话文件，成功后尽力清理空项目目录。
 *
 * 路径安全：projectHash / sessionId 均须匹配安全字符集（拒绝路径分隔符与
 * `..`），防止把操作引导到 sessions 根之外。
 */

import { readFile, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSessionRecord, type SessionRecord } from './log';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 会话存储构造选项。 */
export interface SessionStoreOptions {
  /** 用户主目录：会话根为 `<homeDir>/.modou/sessions`（缺省 os.homedir()）。 */
  readonly homeDir?: string;
}

/** 一次会话的摘要（列表项）。 */
export interface SessionSummary {
  readonly projectHash: string;
  readonly sessionId: string;
  /** 日志文件绝对路径。 */
  readonly path: string;
  /** 首条记录的 ts（全坏行时为文件 mtime）。 */
  readonly firstTs: number;
  /** 末条记录的 ts（全坏行时为文件 mtime）。 */
  readonly lastTs: number;
  /** 记录里的最大 seq（全坏行为 0）。 */
  readonly maxSeq: number;
  /** 有效记录数。 */
  readonly entryCount: number;
  /** 文件字节数。 */
  readonly sizeBytes: number;
}

/** 单条会话的读取结果。 */
export interface SessionReadResult {
  readonly sessionId: string;
  readonly path: string;
  /** 逐行解析出的有效记录（保持文件顺序）。 */
  readonly records: readonly SessionRecord[];
  /** 被跳过的坏行行号（1-based，含非 JSON 与结构非法行）。 */
  readonly skippedLines: readonly number[];
}

/** 安全字符集：拒绝路径分隔符与 `.` / `..`，杜绝路径逃逸。 */
const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;

function assertSafeToken(token: string, label: string): void {
  if (!SAFE_TOKEN.test(token) || token === '.' || token === '..') {
    throw new Error(
      `非法${label} "${token}"：只允许字母/数字/._-，且不得为 . 或 ..`,
    );
  }
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

/** 会话存储：只读访问与管理 `~/.modou/sessions/` 下的 JSONL 会话文件。 */
export class SessionStore {
  /** 会话根目录：`<homeDir>/.modou/sessions`。 */
  readonly sessionsRoot: string;

  constructor(options: SessionStoreOptions = {}) {
    const home = options.homeDir ?? homedir();
    this.sessionsRoot = join(home, '.modou', 'sessions');
  }

  /**
   * 列出所有含会话的项目哈希目录（每个至少有一个 `.jsonl`），按哈希升序。
   * sessions 根不存在时返回空数组。
   */
  async projects(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.sessionsRoot);
    } catch {
      return [];
    }
    const projects: string[] = [];
    for (const name of names) {
      const dir = join(this.sessionsRoot, name);
      let files: string[];
      try {
        const entryStat = await stat(dir);
        if (!entryStat.isDirectory()) continue;
        files = await readdir(dir);
      } catch {
        continue; // 目录已被并发删除等：跳过
      }
      if (files.some((file) => file.endsWith('.jsonl'))) {
        projects.push(name);
      }
    }
    projects.sort();
    return projects;
  }

  /**
   * 列出某项目下的会话，按时间倒序（`lastTs` 降序；同 ts 按 sessionId 倒序
   * 保证确定性）。项目不存在时返回空数组。
   */
  async list(projectHashInput: string): Promise<SessionSummary[]> {
    assertSafeToken(projectHashInput, '项目哈希');
    const dir = join(this.sessionsRoot, projectHashInput);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const summaries: SessionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (!SAFE_TOKEN.test(sessionId)) continue; // 防御：非本模块产出的文件名
      const path = join(dir, name);
      const scan = await scanSessionFile(path);
      const sizeBytes = await fileSize(path);
      summaries.push({
        projectHash: projectHashInput,
        sessionId,
        path,
        firstTs: scan.firstTs,
        lastTs: scan.lastTs,
        maxSeq: scan.maxSeq,
        entryCount: scan.entryCount,
        sizeBytes,
      });
    }
    summaries.sort(
      (a, b) => b.lastTs - a.lastTs || b.sessionId.localeCompare(a.sessionId),
    );
    return summaries;
  }

  /**
   * 逐行读取单条会话：JSON 可解析且结构合法（seq/ts 数字、kind 已知、data
   * 对象）的记录进入 `records`；坏行跳过并记入 `skippedLines`（行号，1-based）。
   * 文件不存在返回 null。
   */
  async read(
    projectHashInput: string,
    sessionId: string,
  ): Promise<SessionReadResult | null> {
    assertSafeToken(projectHashInput, '项目哈希');
    assertSafeToken(sessionId, '会话 ID');
    const path = join(
      this.sessionsRoot,
      projectHashInput,
      `${sessionId}.jsonl`,
    );
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (cause) {
      if (isErrno(cause) && cause.code === 'ENOENT') return null;
      throw cause;
    }
    const records: SessionRecord[] = [];
    const skippedLines: number[] = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (line === '') continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isSessionRecord(parsed)) {
          records.push(parsed);
        } else {
          skippedLines.push(index + 1);
        }
      } catch {
        skippedLines.push(index + 1);
      }
    }
    return { sessionId, path, records, skippedLines };
  }

  /**
   * 删除一条会话；成功后尽力删除空的项目目录（best-effort）。
   * 返回是否真的删除了文件（文件不存在返回 false）。
   */
  async delete(projectHashInput: string, sessionId: string): Promise<boolean> {
    assertSafeToken(projectHashInput, '项目哈希');
    assertSafeToken(sessionId, '会话 ID');
    const path = join(
      this.sessionsRoot,
      projectHashInput,
      `${sessionId}.jsonl`,
    );
    try {
      await unlink(path);
    } catch (cause) {
      if (isErrno(cause) && cause.code === 'ENOENT') return false;
      throw cause;
    }
    // 清理空项目目录：ENOTEMPTY 等失败可忽略（目录还有别的会话）
    await rmdir(join(this.sessionsRoot, projectHashInput)).catch(() => {});
    return true;
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 扫描一个会话文件的摘要（首/末 ts、最大 seq、有效记录数）。 */
async function scanSessionFile(path: string): Promise<{
  firstTs: number;
  lastTs: number;
  maxSeq: number;
  entryCount: number;
}> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { firstTs: 0, lastTs: 0, maxSeq: 0, entryCount: 0 };
  }
  let firstTs = 0;
  let lastTs = 0;
  let maxSeq = 0;
  let entryCount = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isSessionRecord(parsed)) {
        if (firstTs === 0 || parsed.ts < firstTs) firstTs = parsed.ts;
        if (parsed.ts > lastTs) lastTs = parsed.ts;
        if (parsed.seq > maxSeq) maxSeq = parsed.seq;
        entryCount += 1;
      }
    } catch {
      // 坏行在 list 摘要里不计入（read 时才逐条标记行号）
    }
  }
  if (entryCount === 0) {
    // 全坏行 / 空文件：用文件 mtime 兜底排序键
    const entryStat = await stat(path);
    return {
      firstTs: entryStat.mtimeMs,
      lastTs: entryStat.mtimeMs,
      maxSeq: 0,
      entryCount: 0,
    };
  }
  return { firstTs, lastTs, maxSeq, entryCount };
}

/** 文件字节数（读取失败返回 0）。 */
async function fileSize(path: string): Promise<number> {
  try {
    const entryStat = await stat(path);
    return entryStat.size;
  } catch {
    return 0;
  }
}

/** 窄化 Node 错误对象（读取 ErrnoException.code 用）。 */
function isErrno(cause: unknown): cause is { code?: string } {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code !== undefined
  );
}
