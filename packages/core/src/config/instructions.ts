/**
 * 指令文件加载（design 002 九节 / 0.8.0-kickoff 3.2，T-081）：给模型读的项目指令。
 *
 * 与 settings.ts（配置，给程序读的结构化设置）分开。加载规则（002 九节）：
 * - 从 cwd 向上走到项目根（优先找最近的含 `.git` 的祖先目录作为 git 仓库边界；
 *   无 git 时取最顶层含 AGENTS.md / CLAUDE.md 的祖先目录），逐级收集 AGENTS.md
 *   （主）与 CLAUDE.md（兼容，AGENTS.md 优先）；
 * - 加 `~/.modou/AGENTS.md` 全局层；
 * - 按「全局 → 项目根 → 子目录」顺序拼接，越近越靠后（越靠后越有效）；
 * - 每份文件带「来源：」路径头（模型能看出规则出处）；
 * - 总量 32KB 上限：超出时优先保留靠后的高优先级部分（丢弃低优先级文件、
 *   必要时截断单份文件的头部并加截断标记），并发 notice 告警——静默截断不可接受。
 *
 * 模块依赖约束（002 2.2）：Config 不依赖 core 其他模块，本模块只依赖 node 内建
 * （fs / path），与 settings.ts 一致，不 import 任何 core 符号。
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 指令总量上限（字节，utf-8；002 九节「总量 32KB 上限」）。 */
export const DEFAULT_INSTRUCTIONS_LIMIT_BYTES = 32 * 1024;

/** 收集到的指令文件：来源 + 内容（trim 后）+ 是否被截断。 */
export interface InstructionFile {
  /** 来源文件绝对路径（同时渲染为「来源：」头，让模型知道规则出处）。 */
  readonly path: string;
  /** 文件原始内容（trim 后；不含来源头）。 */
  readonly content: string;
  /** 内容被截断（仅单份文件横跨总量上限时）。 */
  readonly truncated?: boolean;
}

/** loadInstructions 入参。 */
export interface LoadInstructionsOptions {
  /** 引导主目录：全局层位于 `<homeDir>/.modou/AGENTS.md`。 */
  readonly homeDir: string;
  /** 工作目录：向上收集指令的起点。 */
  readonly cwd: string;
  /** 总量上限（字节，utf-8）；缺省 32KB。 */
  readonly limitBytes?: number;
}

/** loadInstructions 产出：收集结果 + 渲染文本 + 截断告警信息。 */
export interface LoadInstructionsResult {
  /** 进入文本的指令文件（全局 → 项目根 → 子目录；越靠后越有效）。 */
  readonly files: readonly InstructionFile[];
  /** 渲染后的指令段（含小节标题与「来源：」头；受 limitBytes 约束）。 */
  readonly text: string;
  /** 是否触顶截断（超限 = 丢弃了低优先级文件或截断了单份内容）。 */
  readonly truncated: boolean;
  /** 被整体丢弃的文件路径（截断时说明「截断了哪部分」）。 */
  readonly dropped: readonly string[];
  /** 截断告警文本（truncated 时给出，供调用方发 notice；否则 undefined）。 */
  readonly notice?: string;
}

// ---------------------------------------------------------------------------
// 内部常量
// ---------------------------------------------------------------------------

/**
 * 指令段的小节标题（作为 extra 段首，让模型知道这是项目指令；同时说明
 * 优先级顺序——后出现的节覆盖先出现的节，即越靠近工作目录越有效）。
 */
const SECTION_HEADING =
  '## 项目指令\n\n' +
  '以下指令按「全局 → 项目根 → 子目录」顺序拼接，越靠后的越有效' +
  '（子目录规则覆盖根规则，根规则覆盖全局层）。各节注明来源文件：';

/** 截断标记：被截断内容的末尾标注，让模型知道信息不全（002 5.4 截断要出声）。 */
const TRUNCATION_MARKER = '\n\n…[本文件指令超过总量上限，内容已截断]';

/** 块间分隔（join('\n\n') 的分隔字节数；与 truncateFile 保持一致）。 */
const SEPARATOR_BYTES = 2;

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 窄化 Node 错误对象（读取 ErrnoException.code 用，与 settings.ts 同款）。 */
function isErrno(cause: unknown): cause is { code?: string } {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code !== undefined
  );
}

/** 读取文件文本；不存在 / 是目录（ENOENT / EISDIR）返回 null，其余错误上抛。 */
function readFileIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    if (
      isErrno(cause) &&
      (cause.code === 'ENOENT' || cause.code === 'EISDIR')
    ) {
      return null;
    }
    throw cause;
  }
}

/** 路径是否存在（.git 可能是目录或 worktree 标记文件，两者都算）。 */
function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 是否为普通文件（存在且非目录）。 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** cwd 向上的全部祖先（含 cwd 与文件系统根；返回 [cwd, parent, …, '/']）。 */
function ancestorsFrom(cwd: string): string[] {
  const ancestors: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    ancestors.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break; // 已到文件系统根（Unix '/'；Windows 'C:\\'）
    dir = parent;
  }
  return ancestors;
}

/** 目录里是否存在指令文件（AGENTS.md 或 CLAUDE.md）。 */
function hasInstructionFile(dir: string): boolean {
  return isFile(join(dir, 'AGENTS.md')) || isFile(join(dir, 'CLAUDE.md'));
}

/**
 * 项目根（向上收集的边界）：
 * - 优先取最近的含 `.git` 的祖先（git 仓库边界——仓库以上的指令不属于本项目）；
 * - 无 git 时取最顶层含 AGENTS.md / CLAUDE.md 的祖先（指令所在的最上层）；
 * - 都没有则回落 cwd。
 */
function findProjectRoot(cwd: string): string {
  const ancestors = ancestorsFrom(cwd);
  const gitBoundary = ancestors.find((dir) => pathExists(join(dir, '.git')));
  if (gitBoundary !== undefined) return gitBoundary;
  const topmost = [...ancestors].reverse().find(hasInstructionFile);
  return topmost ?? resolve(cwd);
}

/**
 * 单个目录的指令文件：AGENTS.md 优先，其次 CLAUDE.md（兼容）；
 * 都不存在、或内容为空（trim 后）时返回 null（空文件视为无指令，落到兼容文件）。
 */
function instructionFileFor(dir: string): InstructionFile | null {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const path = join(dir, name);
    const content = readFileIfPresent(path);
    if (content !== null) {
      const trimmed = content.trim();
      if (trimmed.length === 0) continue;
      return { path, content: trimmed };
    }
  }
  return null;
}

/**
 * 收集指令文件（纯函数，供 loadInstructions 使用）：全局层 + 项目根到 cwd 的各级。
 * 返回顺序 = 拼接顺序：全局 → 根 → 子目录（越靠后越有效）。
 */
function collectFiles(options: LoadInstructionsOptions): InstructionFile[] {
  const files: InstructionFile[] = [];

  // 全局层：~/.modou/AGENTS.md
  const globalPath = join(resolve(options.homeDir), '.modou', 'AGENTS.md');
  const globalContent = readFileIfPresent(globalPath);
  if (globalContent !== null && globalContent.trim().length > 0) {
    files.push({ path: globalPath, content: globalContent.trim() });
  }

  // 项目层：根 → … → cwd 逐级（cwd 最近，放最后 = 最高优先级）
  const cwd = resolve(options.cwd);
  const root = findProjectRoot(cwd);
  const levels: string[] = [];
  let dir = cwd;
  for (;;) {
    levels.unshift(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break; // 防御：正常到不了（root 必是 cwd 的祖先）
    dir = parent;
  }
  for (const level of levels) {
    const file = instructionFileFor(level);
    if (file !== null) files.push(file);
  }

  return files;
}

/** 渲染单份文件块：「来源：」头 + 内容。 */
function renderBlock(file: InstructionFile): string {
  return `### 来源：${file.path}\n\n${file.content}`;
}

/** 字符串的 utf-8 字节数。 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 按 utf-8 字节上限截断字符串（回退到最后一个非续字节边界，不切断多字节字符）。 */
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1; // 跳过 UTF-8 续字节
  return buffer.subarray(0, end).toString('utf8');
}

/**
 * 单份文件放不下剩余预算时：保留「来源：」头 + 内容的开头（含截断标记），
 * 其余内容丢弃。预算连来源头都放不下时返回 null（整份丢弃，交给 dropped 报告）。
 */
function truncateFile(
  file: InstructionFile,
  budget: number,
): InstructionFile | null {
  const sourceHeader = `### 来源：${file.path}\n\n`;
  const available = budget - SEPARATOR_BYTES;
  if (available < byteLength(sourceHeader)) return null;
  const contentBudget =
    available - byteLength(sourceHeader) - byteLength(TRUNCATION_MARKER);
  if (contentBudget <= 0) {
    // 内容预算为零：只保留来源头（已能说明出处，内容全弃）
    return { path: file.path, content: '', truncated: true };
  }
  return {
    path: file.path,
    content: truncateUtf8(file.content, contentBudget) + TRUNCATION_MARKER,
    truncated: true,
  };
}

/** 截断告警文本：说明总量上限与「截断了哪部分」（整体丢弃 + 部分截断），不静默。 */
function buildNotice(
  limitBytes: number,
  dropped: readonly string[],
  partial: InstructionFile | null,
): string {
  const limitKb = Math.round(limitBytes / 1024);
  const parts: string[] = [];
  if (partial !== null) {
    parts.push(`部分保留 ${partial.path}（保留开头，其余截断）`);
  }
  if (dropped.length > 0) {
    parts.push(`已丢弃（低优先级在前）：${dropped.join('、')}`);
  }
  return `项目指令总量超过 ${limitKb}KB 上限，已截断——${parts.join('；')}。如需全部生效，请精简上述指令文件。`;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 加载并渲染指令文件（纯函数，可离线测试）：
 * 收集 → 按「全局 → 项目根 → 子目录」拼接（带来源头）→ 32KB 上限截断 + 告警。
 *
 * 结果里的 `text` 可直接作为 buildSystemPrompt 的 `extra` 注入系统提示词；
 * `truncated` 时 `notice` 为告警文本（调用方应以 notice 事件展示，不静默）。
 */
export function loadInstructions(
  options: LoadInstructionsOptions,
): LoadInstructionsResult {
  const limitBytes = options.limitBytes ?? DEFAULT_INSTRUCTIONS_LIMIT_BYTES;
  const files = collectFiles(options);
  if (files.length === 0) {
    return { files: [], text: '', truncated: false, dropped: [] };
  }

  const headerBytes = byteLength(SECTION_HEADING);
  let budget = Math.max(0, limitBytes - headerBytes);

  const kept: InstructionFile[] = [];
  const dropped: string[] = [];
  let partial: InstructionFile | null = null;

  // 从高优先级（靠后）向低优先级（靠前）装填：整块放得下就保留，
  // 放不下时要么丢弃该份及更早的（保留已装填的靠后高优先级部分），
  // 要么截断单份内容（仅当它是唯一候选、无可丢弃的更低优先级文件时）。
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const file = files[index];
    const blockBytes = byteLength(renderBlock(file)) + SEPARATOR_BYTES;
    if (blockBytes <= budget) {
      kept.unshift(file);
      budget -= blockBytes;
      continue;
    }
    if (kept.length === 0) {
      // 最高优先级的一份也放不下整块：保留其头部，其余（更早的）全部丢弃
      partial = truncateFile(file, budget);
      if (partial !== null) {
        kept.unshift(partial);
        dropped.push(...files.slice(0, index).map((f) => f.path));
      } else {
        dropped.push(...files.slice(0, index + 1).map((f) => f.path));
      }
    } else {
      // 已有保留（靠后高优先级）：当前份及更早（低优先级）全部丢弃
      dropped.push(...files.slice(0, index + 1).map((f) => f.path));
    }
    break;
  }

  const truncated = dropped.length > 0 || partial !== null;
  const text =
    kept.length === 0
      ? ''
      : [SECTION_HEADING, ...kept.map(renderBlock)].join('\n\n');

  return {
    files: kept,
    text,
    truncated,
    dropped,
    ...(truncated ? { notice: buildNotice(limitBytes, dropped, partial) } : {}),
  };
}
