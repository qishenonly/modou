/**
 * 图片输入（T-133，0.13.0）：多模态消息构造 + 供应商能力探测与降级。
 *
 * - `detectImageSupport(capabilities)`：按供应商能力描述（capabilities.images，
 *   design 002 8.1）判断当前模型能否处理图片——差异全部吸收在适配层，调用方
 *   永远不写 `if (provider === ...)`；
 * - `attachImagesToUserMessage`：把「文件路径 / http(s) URL / data: URI」构造
 *   成 AI SDK v7 的 user 消息（文本 + 图片 FilePart，002 3.3 submit 携带
 *   附件引用）；本地文件读取为 data URL（base64）；
 * - 不支持时降级（不静默）：返回「仅文本 + 明确说明」的消息与 notice——模型
 *   看到的是「用户发了 N 张图但我无法处理」的诚实降级，不是假装看懂。
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ModelMessage } from 'ai';
import type { ProviderCapabilities } from '../provider/capabilities';

// ---------------------------------------------------------------------------
// 能力探测
// ---------------------------------------------------------------------------

/** 当前模型是否支持图片输入（能力描述是唯一依据，002 8.1）。 */
export function detectImageSupport(
  capabilities: ProviderCapabilities,
): boolean {
  return capabilities.images;
}

// ---------------------------------------------------------------------------
// MIME 判定
// ---------------------------------------------------------------------------

/** 常见图片扩展名 → MIME。未知返回 'image/png' 兜底（尽力而为，探测不崩溃）。 */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
};

/** 按扩展名取图片 MIME（未知回退 'image/png'；路径无扩展名时同样兜底）。 */
export function imageMimeFromPath(path: string): string {
  return IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'image/png';
}

// ---------------------------------------------------------------------------
// 多模态消息构造
// ---------------------------------------------------------------------------

/** attachImagesToUserMessage 的入参。 */
export interface ImageInputOptions {
  /** 用户的文本指令（图片之外的说明 / 要求）。 */
  readonly prompt: string;
  /** 图片来源：本地文件路径 / http(s) URL / data: URI。 */
  readonly images: readonly string[];
  /** 当前模型的能力描述（据此决定构造多模态还是降级）。 */
  readonly capabilities: ProviderCapabilities;
}

/** attachImagesToUserMessage 的产出。 */
export interface ImageInputResult {
  /** 构造好的 user 消息（支持时含图片 FilePart；不支持时仅文本 + 说明）。 */
  readonly messages: readonly ModelMessage[];
  /** 降级 / 跳过说明（不支持时非空；支持时为空）。调用方以 notice 呈现。 */
  readonly notices: readonly string[];
}

/**
 * 把图片来源归一为 AI SDK 的 FilePart（data 或 url 两种形态）。
 *
 * - data: URI → 拆出 mediaType + base64 数据（data 形态，跨供应商可移植）；
 * - http(s) URL → url 形态（provider 侧拉取）；
 * - 本地路径 → 读文件 → Uint8Array 数据（data 形态）。
 * 读取失败（文件不存在 / 不可读）返回 null——调用方以 notice 说明并跳过该图，
 * 不因单张图失败而中断整个消息构造（错误即数据，002 5.3）。
 */
export async function toImageFileParts(
  images: readonly string[],
): Promise<{
  parts: readonly ModelMessageUserFilePart[];
  failed: readonly string[];
}> {
  const parts: ModelMessageUserFilePart[] = [];
  const failed: string[] = [];
  for (const image of images) {
    if (image.startsWith('data:')) {
      const comma = image.indexOf(',');
      const meta = comma >= 0 ? image.slice(0, comma) : '';
      const data = comma >= 0 ? image.slice(comma + 1) : image;
      const mediaType = /^data:([^;]+)/.exec(meta)?.[1] ?? 'image';
      parts.push({ type: 'file', mediaType, data: { type: 'data', data } });
      continue;
    }
    if (image.startsWith('http://') || image.startsWith('https://')) {
      parts.push({
        type: 'file',
        mediaType: 'image',
        data: { type: 'url', url: new URL(image) },
      });
      continue;
    }
    try {
      const buffer = await readFile(image);
      parts.push({
        type: 'file',
        mediaType: imageMimeFromPath(image),
        data: { type: 'data', data: new Uint8Array(buffer) },
      });
    } catch {
      failed.push(image);
    }
  }
  return { parts, failed };
}

/**
 * 构造多模态 user 消息。
 *
 * - 支持图片（capabilities.images = true）：文本 + 每张图的 FilePart；
 *   读取失败 / 无效 URI 的图跳过并发 notice（不静默）。
 * - 不支持图片：**降级**——消息只剩文本 + 明确说明「当前模型不支持图片输入，
 *   已忽略 N 张图」，并返回对应 notice。绝不假装看懂图片。
 *
 * 返回的 messages 只有一条 user 消息（文本 + 图片 parts）。
 */
export async function attachImagesToUserMessage(
  options: ImageInputOptions,
): Promise<ImageInputResult> {
  if (!detectImageSupport(options.capabilities)) {
    const notice =
      `当前模型不支持图片输入（capabilities.images = false），` +
      `已忽略 ${options.images.length} 张图片（${options.images.join('、')}）。` +
      '如需要处理图片，请切换到支持图片的模型（/model）。';
    return {
      messages: [
        {
          role: 'user',
          content:
            `${options.prompt}\n\n[系统提示] 用户提供了 ${options.images.length} 张图片，` +
            '但当前模型不支持图片输入，无法处理它们——不要臆测图片内容，如有需要请用户换模型重试。',
        },
      ],
      notices: [notice],
    };
  }

  const { parts, failed } = await toImageFileParts(options.images);
  const notices: string[] = [];
  if (failed.length > 0) {
    notices.push(
      `无法读取图片（跳过）：${failed.join('、')}（文件不存在或不可读）`,
    );
  }
  const content: ModelMessageUserPart[] = [
    { type: 'text', text: options.prompt },
    ...parts,
  ];
  return { messages: [{ role: 'user', content }], notices };
}

// ---------------------------------------------------------------------------
// 类型（AI SDK v7 FilePart 的最小投影，避免依赖 ai 内部类型名）
// ---------------------------------------------------------------------------

/** user 消息的 content part（文本 / 图片文件的判别联合最小集）。 */
export type ModelMessageUserPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'file';
      readonly mediaType: string;
      readonly data:
        | { readonly type: 'data'; readonly data: Uint8Array | string }
        | { readonly type: 'url'; readonly url: URL };
    };

/** toImageFileParts 产出的图片 part（FilePart 投影）。 */
export type ModelMessageUserFilePart = Extract<
  ModelMessageUserPart,
  { readonly type: 'file' }
>;
