import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * 文件式长期记忆存储（0.17.0 T-173，ADR 0016：不上向量库）。
 *
 * 记忆 = 项目目录 `.modou/memory/` 下的结构化笔记（markdown 文件）：
 *
 *     <projectRoot>/.modou/memory/<key>.md
 *
 * 文件头是 YAML 风格 frontmatter（`updated` 时间戳），正文是笔记内容——
 * 人类可读、可版本控制（随 .modou/ 提交即可共享项目记忆）、可被任何文本工具
 * 处理。结构化 = 键控（key → 文件）、有界（单条与总量上限）、有元数据（时间戳）。
 *
 * 设计取舍（ADR 0016）：
 * - **不上向量检索**：编码场景下「文件式笔记 + 项目指令」已覆盖 80% 需求；
 *   工作记忆当**上下文预算问题**处理——新会话启动把全部笔记（总量上限内）注入
 *   上下文（loadMemoryText），不建索引、不做相似度检索；
 * - **键即文件名的安全边界**：key 白名单 `[A-Za-z0-9_-]{1,64}`——不允许路径
 *   分隔符 / `..` / 隐藏文件，从结构上杜绝路径穿越（对抗性用例在测试里）；
 * - **跨会话**：同一项目根 → 同一记忆目录 → 新会话启动加载注入（工具与提示词
 *   双通道：loadMemoryText 注入系统提示词，memory_read/write/list 工具会话内读写）。
 *
 * 模块依赖约束（002 2.2）：memory 属于 Config 扩展点，只依赖 node 内建。
 */

/** 记忆笔记文件名后缀。 */
export const MEMORY_NOTE_EXT = '.md';
/** 单条笔记内容上限（字符；超限拒绝，防单条笔记挤爆上下文）。 */
export const MEMORY_NOTE_MAX_CHARS = 8_000;
/** 注入上下文的记忆总量上限（字节；与指令文件 32KB 上限同量级）。 */
export const MEMORY_LOAD_LIMIT_BYTES = 32 * 1024;

/** 一条结构化记忆笔记。 */
export interface MemoryNote {
  /** 键（= 文件名去后缀；白名单字符）。 */
  readonly key: string;
  /** 笔记内容（frontmatter 之后的正文，trim 后）。 */
  readonly content: string;
  /** 最近写入时间（ISO 8601；读取缺省为空串）。 */
  readonly updatedAt?: string;
  /** 来源文件绝对路径。 */
  readonly file: string;
}

/** 记忆键白名单：字母数字 + 下划线/连字符，1~64 字符（不含路径分隔符 / 隐藏文件）。 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 校验记忆键；非法返回 null（路径穿越 / 非法字符从结构上拒绝）。 */
export function sanitizeMemoryKey(key: string): string | null {
  const trimmed = key.trim();
  return KEY_PATTERN.test(trimmed) ? trimmed : null;
}

/** 项目根 → 记忆目录（`<projectRoot>/.modou/memory/`）。 */
export function memoryDirFor(projectRoot: string): string {
  return join(projectRoot, '.modou', 'memory');
}

/** 键 → 笔记文件路径（调用方保证 key 已 sanitize）。 */
function noteFile(dir: string, key: string): string {
  return join(dir, `${key}${MEMORY_NOTE_EXT}`);
}

/** 把一条笔记渲染为落盘形态（frontmatter 头 + 正文）。 */
function serializeNote(key: string, content: string): string {
  const updated = new Date().toISOString();
  return `---\nupdated: ${updated}\n---\n${content}`;
}

/** 解析一份笔记文件文本（frontmatter 缺省容错：整份视为正文）。 */
export function parseNoteFile(
  text: string,
  file: string,
  key: string,
): MemoryNote {
  const lines = text.split(/\r?\n/);
  let updatedAt: string | undefined;
  let body = text;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex(
      (line, index) => index > 0 && line.trim() === '---',
    );
    if (end > 0) {
      const front = lines.slice(1, end).join('\n');
      const match = /^updated:\s*(.+)$/m.exec(front);
      if (match !== null) updatedAt = match[1].trim();
      body = lines.slice(end + 1).join('\n');
    }
  }
  return {
    key,
    content: body.trim(),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    file,
  };
}

/** 写入 / 覆盖一条记忆笔记。key 非法 / 内容超限返回错误文本（错误即数据，不抛）。 */
export function writeMemoryNote(
  dir: string,
  key: string,
  content: string,
): { ok: true; note: MemoryNote } | { ok: false; error: string } {
  const safeKey = sanitizeMemoryKey(key);
  if (safeKey === null) {
    return {
      ok: false,
      error:
        `记忆键 "${key}" 非法：只允许字母数字与下划线/连字符（1~64 字符），` +
        `不允许路径分隔符 / 隐藏文件名——请换一个键名`,
    };
  }
  if (content.trim().length === 0) {
    return { ok: false, error: '记忆内容不能为空' };
  }
  if (content.length > MEMORY_NOTE_MAX_CHARS) {
    return {
      ok: false,
      error: `记忆内容超过上限 ${MEMORY_NOTE_MAX_CHARS} 字符（当前 ${content.length}），请精简`,
    };
  }
  try {
    mkdirSync(dir, { recursive: true });
    const file = noteFile(dir, safeKey);
    // 存储时 trim 首尾空白（笔记正文的噪音不是内容）
    writeFileSync(file, serializeNote(safeKey, content.trim()), 'utf8');
    return { ok: true, note: { key: safeKey, content: content.trim(), file } };
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return { ok: false, error: `记忆写入失败：${reason}` };
  }
}

/** 读取一条记忆笔记；不存在返回 null。 */
export function readMemoryNote(dir: string, key: string): MemoryNote | null {
  const safeKey = sanitizeMemoryKey(key);
  if (safeKey === null) return null;
  const file = noteFile(dir, safeKey);
  try {
    const text = readFileSync(file, 'utf8');
    return parseNoteFile(text, file, safeKey);
  } catch {
    return null;
  }
}

/** 列出全部记忆笔记（按键名排序，确定性；无记忆目录返回空数组）。 */
export function listMemoryNotes(dir: string): MemoryNote[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(MEMORY_NOTE_EXT) && !name.startsWith('.'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  const notes: MemoryNote[] = [];
  for (const name of names) {
    const key = name.slice(0, -MEMORY_NOTE_EXT.length);
    const file = join(dir, name);
    try {
      const text = readFileSync(file, 'utf8');
      notes.push(parseNoteFile(text, file, key));
    } catch {
      // 读取失败的单条笔记跳过（不静默：内容损坏的记忆不注入，避免带病进入上下文）
    }
  }
  return notes;
}

/** 一条笔记的字节数（注入预算核算用）。 */
function noteBytes(note: MemoryNote): number {
  return Buffer.byteLength(note.content, 'utf8');
}

/**
 * 加载全部记忆为注入文本（跨会话加载：新会话启动调用，渲染进系统提示词）。
 *
 * 渲染形态（每个笔记一节）：
 *
 *     ### <key>
 *     <content>
 *
 * 总量预算（limitBytes，缺省 32KB）：超出时按**最近写入优先**保留（updatedAt
 * 降序），丢弃的笔记列出（notice 不静默——截断要出声，002 5.4）。排序：
 * 渲染时按最近写入优先（记忆是新近优先，越新的越相关）。
 */
export function loadMemoryText(
  dir: string,
  limitBytes: number = MEMORY_LOAD_LIMIT_BYTES,
): {
  text: string;
  notes: readonly MemoryNote[];
  truncated: boolean;
  dropped: readonly string[];
  notice?: string;
} {
  const notes = listMemoryNotes(dir);
  if (notes.length === 0)
    return { text: '', notes: [], truncated: false, dropped: [] };

  // 最近写入优先（无时间戳的旧笔记排最后）
  const sorted = [...notes].sort((a, b) => {
    const at = (note: MemoryNote): number =>
      note.updatedAt !== undefined ? Date.parse(note.updatedAt) || 0 : 0;
    return at(b) - at(a);
  });

  const kept: MemoryNote[] = [];
  const dropped: string[] = [];
  let total = 0;
  for (const note of sorted) {
    // 每个笔记渲染后含分隔开销（标题 + 换行）；粗略按内容字节 + 32 字节余量
    const cost = noteBytes(note) + 32;
    if (kept.length > 0 && total + cost > limitBytes) {
      dropped.push(note.key);
      continue;
    }
    kept.push(note);
    total += cost;
  }

  const section =
    kept.length === 0
      ? '## 长期记忆（无内容注入——记忆总量超过上下文预算，全部被丢弃）'
      : `## 长期记忆\n\n以下是你在此前会话中记录的结构化笔记（来源：${dir}），作为跨会话的长期记忆：\n\n${kept
          .map((note) => `### ${note.key}\n\n${note.content}`)
          .join('\n\n')}`;

  return {
    text: section,
    notes: kept,
    truncated: dropped.length > 0,
    dropped,
    ...(dropped.length > 0
      ? {
          notice:
            `长期记忆注入：丢弃 ${dropped.length} 条笔记（记忆总量超过 ${limitBytes} 字节上限` +
            `——${dropped.join('、')}），已按最近写入优先保留 ${kept.length} 条。`,
        }
      : {}),
  };
}

/** 记忆目录是否已存在（TUI 判断是否需要渲染记忆段）。 */
export function hasMemory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
