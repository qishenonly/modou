import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryTools } from './memory';
import {
  MEMORY_WRITE_TOOL_NAME,
  MEMORY_READ_TOOL_NAME,
  MEMORY_LIST_TOOL_NAME,
} from './memory';
import type { ToolContext } from '../types';

/**
 * 长期记忆工具（0.17.0 T-173，ADR 0016）：memory_write/read/list。
 * 覆盖：读写 / 列表 / 非法键 / 不存在 / 风险分类。
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'modou-memtool-'));
}

function ctx(): ToolContext {
  return { signal: new AbortController().signal };
}

describe('createMemoryTools', () => {
  test('三个工具 + 风险分类（write 持久化 / read 读取）', () => {
    const dir = tempDir();
    try {
      const [write, read, list] = createMemoryTools({ dir });
      expect(write.name).toBe(MEMORY_WRITE_TOOL_NAME);
      expect(write.risk).toBe('write');
      expect(read.name).toBe(MEMORY_READ_TOOL_NAME);
      expect(read.risk).toBe('read');
      expect(list.name).toBe(MEMORY_LIST_TOOL_NAME);
      expect(list.risk).toBe('read');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('写入 → 读取 → 列表 全链路', async () => {
    const dir = tempDir();
    try {
      const [write, read, list] = createMemoryTools({ dir });
      const written = await write.execute(
        { key: 'conventions', content: '测试放 src/__tests__。' },
        ctx(),
      );
      expect(written.ok).toBe(true);
      expect(written.forModel).toContain('新会话启动');

      const readOutcome = await read.execute({ key: 'conventions' }, ctx());
      expect(readOutcome.ok).toBe(true);
      expect(readOutcome.forModel).toContain('测试放 src/__tests__。');

      const listOutcome = await list.execute({}, ctx());
      expect(listOutcome.ok).toBe(true);
      expect(listOutcome.forModel).toContain('conventions');
      expect(listOutcome.payload).toMatchObject({
        notes: [{ key: 'conventions' }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('非法键写入拒绝（错误即数据）', async () => {
    const dir = tempDir();
    try {
      const [write] = createMemoryTools({ dir });
      const outcome = await write.execute(
        { key: '../escape', content: 'x' },
        ctx(),
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.forModel).toContain('非法');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('读不存在的键：ok:false 并列出可用记忆键', async () => {
    const dir = tempDir();
    try {
      const [write, read] = createMemoryTools({ dir });
      await write.execute({ key: 'existing', content: 'x' }, ctx());
      const outcome = await read.execute({ key: 'missing' }, ctx());
      expect(outcome.ok).toBe(false);
      expect(outcome.forModel).toContain('不存在');
      expect(outcome.forModel).toContain('existing'); // 列出可用键供核对
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('schema 校验：key/content 必填', async () => {
    const dir = tempDir();
    try {
      const [write, read] = createMemoryTools({ dir });
      expect(write.schema.safeParse({}).success).toBe(false);
      expect(write.schema.safeParse({ key: 'a' }).success).toBe(false);
      expect(write.schema.safeParse({ key: 'a', content: 'b' }).success).toBe(
        true,
      );
      expect(read.schema.safeParse({}).success).toBe(false);
      expect(read.schema.safeParse({ key: 'a' }).success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
