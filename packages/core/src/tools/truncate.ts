import type { TruncationInfo } from './types';

/**
 * 输出截断策略（design 002 5.4）：
 *
 * 超长输出保留头尾、中间省略，并在省略处写明「省略了 N 行 / N 字符」——
 * 截断必须出声，让模型知道信息不全、能主动分页取。悄悄截断会让模型基于
 * 残缺信息做判断，这比报错更糟。
 *
 * 两级截断：
 * - 行级（结构）：超过 maxLines 行，保留头部 headLines 行 + 尾部 tailLines 行；
 * - 字符级（安全帽）：行级之后若仍超过 maxChars 字符，保留头尾字符。
 * 两者都配置化，管线 Normalize 以默认值兜底，具体工具可收窄。
 */

export interface TruncateLinesOptions {
  /** 行数上限：超过即截断。默认 500。 */
  readonly maxLines?: number;
  /** 保留的头部行数。默认 50。 */
  readonly headLines?: number;
  /** 保留的尾部行数。默认 50。 */
  readonly tailLines?: number;
}

export interface TruncateCharsOptions {
  /** 字符数上限：超过即截断。默认 30_000。 */
  readonly maxChars?: number;
  /** 保留的头部字符数。默认 12_000。 */
  readonly headChars?: number;
  /** 保留的尾部字符数。默认 8_000。 */
  readonly tailChars?: number;
}

export interface TruncationOptions
  extends TruncateLinesOptions, TruncateCharsOptions {}

/** 行级截断的省略标记：写明省略行数，并提示可分页获取。 */
const LINE_MARKER = (omittedLines: number): string =>
  `\n\n…（此处省略了 ${omittedLines} 行，如需完整内容请分页获取）…\n\n`;

/** 字符级截断的省略标记：写明省略字符数。 */
const CHAR_MARKER = (omittedChars: number): string =>
  `…（此处省略了 ${omittedChars} 字符）…`;

/**
 * 行级截断：保留头尾、中间省略。字符数以 UTF-16 码元近似计。
 * 仅当行数超过 maxLines 时才截断；head+tail 超限时按 maxLines 夹取。
 */
export function truncateLines(
  text: string,
  options: TruncateLinesOptions = {},
): { readonly text: string; readonly info: TruncationInfo } {
  const maxLines = options.maxLines ?? 500;
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return { text, info: { truncated: false } };
  }

  let head = options.headLines ?? 50;
  let tail = options.tailLines ?? 50;
  if (head + tail > maxLines) {
    head = Math.floor(maxLines / 2);
    tail = maxLines - head;
  }

  const omittedLines = lines.length - head - tail;
  const headPart = lines.slice(0, head);
  const tailPart = lines.slice(lines.length - tail);
  return {
    text: headPart.join('\n') + LINE_MARKER(omittedLines) + tailPart.join('\n'),
    info: { truncated: true, omittedLines },
  };
}

/**
 * 字符级截断（安全帽）：对任意文本强制字符上限，保留头尾、中间省略。
 */
export function truncateChars(
  text: string,
  options: TruncateCharsOptions = {},
): { readonly text: string; readonly info: TruncationInfo } {
  const maxChars = options.maxChars ?? 30_000;
  if (text.length <= maxChars) {
    return { text, info: { truncated: false } };
  }

  let head = options.headChars ?? 12_000;
  let tail = options.tailChars ?? 8_000;
  if (head + tail > maxChars) {
    head = Math.floor(maxChars / 2);
    tail = maxChars - head;
  }

  const omittedChars = text.length - head - tail;
  return {
    text:
      text.slice(0, head) +
      CHAR_MARKER(omittedChars) +
      text.slice(text.length - tail),
    info: { truncated: true, omittedChars },
  };
}

/**
 * 统一截断：先按行截断，再按字符数强制上限。
 * 返回截断后的文本与截断信息（省略行数 / 省略字符数，两者可同时存在）。
 */
export function truncateOutput(
  text: string,
  options: TruncationOptions = {},
): { readonly text: string; readonly info: TruncationInfo } {
  const byLines = truncateLines(text, options);
  const byChars = truncateChars(byLines.text, options);
  return {
    text: byChars.text,
    info: {
      truncated: byLines.info.truncated || byChars.info.truncated,
      ...(byLines.info.omittedLines !== undefined
        ? { omittedLines: byLines.info.omittedLines }
        : {}),
      ...(byChars.info.omittedChars !== undefined
        ? { omittedChars: byChars.info.omittedChars }
        : {}),
    },
  };
}
