/**
 * T-133 图片输入离线测试。
 *
 * 覆盖：
 * - detectImageSupport：能力描述（capabilities.images）是唯一依据；
 * - 支持路径：本地文件路径 → data URL（base64 内联），http(s) URL / data URI
 *   直接透传，user 消息 = 文本 + 图片 FilePart；
 * - 不支持降级：消息只剩文本 + 明确说明（绝不假装看懂图片），notice 说明；
 * - 读取失败：跳过该图并发 notice（不中断整个消息构造）；
 * - imageMimeFromPath：常见扩展名 → MIME，未知兜底。
 *
 * 全部离线：临时文件 + 纯函数构造，不访问外网。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderCapabilities } from '../provider/capabilities';
import {
  attachImagesToUserMessage,
  detectImageSupport,
  imageMimeFromPath,
} from './image';

const tmpDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'modou-image-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 最小 PNG（1x1 像素的合法文件头；base64 可验证）。 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function capabilitiesWith(images: boolean): ProviderCapabilities {
  return {
    maxContext: 128_000,
    parallelToolCalls: false,
    cacheBreakpoints: false,
    images,
    thinking: 'none',
    strictJsonArgs: true,
  };
}

describe('detectImageSupport（T-133 能力探测）', () => {
  test('capabilities.images 是唯一依据', () => {
    expect(detectImageSupport(capabilitiesWith(true))).toBe(true);
    expect(detectImageSupport(capabilitiesWith(false))).toBe(false);
  });
});

describe('attachImagesToUserMessage（T-133 多模态消息构造）', () => {
  test('支持路径：本地文件 → Uint8Array 数据，消息 = 文本 + 图片 FilePart', async () => {
    const dir = tempDir();
    const pngPath = join(dir, 'shot.png');
    writeFileSync(pngPath, Buffer.from(TINY_PNG_BASE64, 'base64'));

    const built = await attachImagesToUserMessage({
      prompt: '请看这张截图',
      images: [pngPath],
      capabilities: capabilitiesWith(true),
    });

    expect(built.notices).toEqual([]);
    expect(built.messages).toHaveLength(1);
    const content = built.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; [key: string]: unknown }>;
    expect(parts[0]).toMatchObject({ type: 'text', text: '请看这张截图' });
    expect(parts[1]).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
      data: { type: 'data' },
    });
    const fileData = parts[1]?.data as { type: string; data: Uint8Array };
    expect(fileData.data).toBeInstanceOf(Uint8Array);
    // 字节与写盘的最小 PNG 一致
    expect(Buffer.from(fileData.data).toString('base64')).toBe(TINY_PNG_BASE64);
  });

  test('支持路径：http(s) URL → url 形态（URL 对象），data URI → data 形态', async () => {
    const built = await attachImagesToUserMessage({
      prompt: '看看这个图',
      images: ['https://example.com/a.png', 'data:image/png;base64,AAA='],
      capabilities: capabilitiesWith(true),
    });
    const parts = built.messages[0]?.content as Array<{
      type: string;
      data: { type: string; data?: unknown; url?: unknown };
    }>;
    expect(parts[1]).toMatchObject({ type: 'file', mediaType: 'image' });
    expect((parts[1]?.data as { url: URL }).url).toBeInstanceOf(URL);
    expect(String((parts[1]?.data as { url: URL }).url)).toBe(
      'https://example.com/a.png',
    );
    // data URI：拆出 mediaType + base64 数据（不含 data: 前缀）
    expect(parts[2]).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
      data: { type: 'data', data: 'AAA=' },
    });
    expect(built.notices).toEqual([]);
  });

  test('不支持降级：消息只剩文本 + 明确说明，notice 告知（绝不假装看懂）', async () => {
    const built = await attachImagesToUserMessage({
      prompt: '这个 UI 有问题',
      images: ['/tmp/nope.png'],
      capabilities: capabilitiesWith(false),
    });

    expect(built.notices.length).toBe(1);
    expect(built.notices[0]).toContain('不支持图片输入');
    expect(built.notices[0]).toContain('1 张图片');
    // 消息是纯文本，且明确告诉模型「不要臆测图片内容」
    const content = built.messages[0]?.content;
    expect(typeof content).toBe('string');
    expect(content as string).toContain('这个 UI 有问题');
    expect(content as string).toContain('不支持图片输入');
    expect(content as string).toContain('不要臆测图片内容');
  });

  test('支持但读取失败：跳过该图并发 notice，其余图照常构造', async () => {
    const dir = tempDir();
    const goodPath = join(dir, 'good.png');
    writeFileSync(goodPath, Buffer.from(TINY_PNG_BASE64, 'base64'));

    const built = await attachImagesToUserMessage({
      prompt: '处理这些图',
      images: [goodPath, join(dir, 'missing.png')],
      capabilities: capabilitiesWith(true),
    });

    expect(built.notices.length).toBe(1);
    expect(built.notices[0]).toContain('无法读取图片');
    expect(built.notices[0]).toContain('missing.png');
    // 成功的图仍进入消息
    const parts = built.messages[0]?.content as Array<{ type: string }>;
    expect(parts.filter((part) => part.type === 'file')).toHaveLength(1);
  });
});

describe('imageMimeFromPath（T-133 MIME 判定）', () => {
  test('常见扩展名 → MIME，未知兜底 image/png', () => {
    expect(imageMimeFromPath('/a/b/photo.jpeg')).toBe('image/jpeg');
    expect(imageMimeFromPath('/a/b/photo.JPG')).toBe('image/jpeg');
    expect(imageMimeFromPath('/a/b/icon.webp')).toBe('image/webp');
    expect(imageMimeFromPath('/a/b/vector.svg')).toBe('image/svg+xml');
    expect(imageMimeFromPath('/a/b/unknown.bin')).toBe('image/png');
  });
});
