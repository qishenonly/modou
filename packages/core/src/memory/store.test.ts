import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadMemoryText,
  listMemoryNotes,
  memoryDirFor,
  readMemoryNote,
  sanitizeMemoryKey,
  writeMemoryNote,
  MEMORY_LOAD_LIMIT_BYTES,
  MEMORY_NOTE_MAX_CHARS,
} from './store';

/**
 * 文件式长期记忆存储（0.17.0 T-173，ADR 0016）：键控文件 + 有界 + 跨会话加载。
 * 覆盖：读写 / 列表 / 键白名单（路径穿越对抗）/ 大小上限 / 跨会话加载注入。
 */

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `modou-memory-${label}-`));
}

describe('sanitizeMemoryKey', () => {
  test('合法键：字母数字 + 下划线/连字符', () => {
    expect(sanitizeMemoryKey('project-conventions')).toBe(
      'project-conventions',
    );
    expect(sanitizeMemoryKey('cwd_notes')).toBe('cwd_notes');
    expect(sanitizeMemoryKey('  trimmed-key  ')).toBe('trimmed-key');
  });

  test('路径穿越 / 非法字符拒绝（对抗性用例）', () => {
    expect(sanitizeMemoryKey('../evil')).toBeNull();
    expect(sanitizeMemoryKey('a/b')).toBeNull();
    expect(sanitizeMemoryKey('.hidden')).toBeNull();
    expect(sanitizeMemoryKey('..')).toBeNull();
    expect(sanitizeMemoryKey('a b')).toBeNull();
    expect(sanitizeMemoryKey('')).toBeNull();
    expect(sanitizeMemoryKey('a'.repeat(65))).toBeNull();
  });
});

describe('writeMemoryNote / readMemoryNote / listMemoryNotes', () => {
  test('写入后可读，内容与键一致', () => {
    const dir = tempDir('rw');
    try {
      const written = writeMemoryNote(
        dir,
        'decision',
        '采用 Bun 构建，理由：单文件分发。',
      );
      expect(written.ok).toBe(true);
      if (written.ok) {
        expect(written.note.key).toBe('decision');
        const read = readMemoryNote(dir, 'decision');
        expect(read?.content).toContain('采用 Bun 构建');
        expect(read?.file).toContain('decision.md');
        expect(read?.updatedAt).toBeTruthy();
        // 落盘形态含 frontmatter 头（结构化笔记）
        const raw = readFileSync(join(dir, 'decision.md'), 'utf8');
        expect(raw.startsWith('---\nupdated:')).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('同名键覆盖（更新记忆）', () => {
    const dir = tempDir('overwrite');
    try {
      writeMemoryNote(dir, 'key', 'v1');
      writeMemoryNote(dir, 'key', 'v2');
      expect(readMemoryNote(dir, 'key')?.content).toBe('v2');
      expect(listMemoryNotes(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('非法键写入拒绝（错误即数据，不写盘）', () => {
    const dir = tempDir('badkey');
    try {
      const result = writeMemoryNote(dir, '../escape', 'x');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('非法');
      expect(existsSync(join(dir, '..', 'escape.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('内容超限拒绝', () => {
    const dir = tempDir('big');
    try {
      const result = writeMemoryNote(
        dir,
        'big',
        'x'.repeat(MEMORY_NOTE_MAX_CHARS + 1),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('上限');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('空内容拒绝', () => {
    const dir = tempDir('empty');
    try {
      const result = writeMemoryNote(dir, 'empty', '   ');
      expect(result.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('读不存在的键返回 null；无记忆目录列出为空', () => {
    const dir = tempDir('missing');
    try {
      expect(readMemoryNote(dir, 'nope')).toBeNull();
      expect(listMemoryNotes(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadMemoryText（跨会话加载）', () => {
  test('新「会话」加载既有记忆：全部笔记注入 + 最近写入优先排序', () => {
    const dir = tempDir('cross');
    try {
      // 会话 1：写入两条
      writeMemoryNote(dir, 'conventions', '测试文件放 src/__tests__。');
      writeMemoryNote(dir, 'decision', '不引入额外 UI 框架。');
      // 会话 2（全新进程）：loadMemoryText 加载全部
      const loaded = loadMemoryText(dir);
      expect(loaded.text).toContain('## 长期记忆');
      expect(loaded.text).toContain('### conventions');
      expect(loaded.text).toContain('测试文件放 src/__tests__。');
      expect(loaded.text).toContain('### decision');
      expect(loaded.text).toContain('不引入额外 UI 框架。');
      expect(loaded.truncated).toBe(false);
      expect(loaded.notes).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('总量超限：最近写入优先保留，丢弃的列在 notice（不静默）', () => {
    const dir = tempDir('budget');
    try {
      writeMemoryNote(dir, 'old', '旧'.repeat(3_000)); // 单条上限内，但注入预算外
      writeMemoryNote(dir, 'new', '新'.repeat(100));
      const loaded = loadMemoryText(dir, 4_000);
      expect(loaded.truncated).toBe(true);
      expect(loaded.dropped).toContain('old'); // 旧的被丢弃
      expect(loaded.notice).toContain('old');
      expect(loaded.text).toContain('new');
      expect(loaded.text).not.toContain('旧'.repeat(3_000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('无记忆目录返回空 text（不抛错）', () => {
    const dir = tempDir('none');
    try {
      const loaded = loadMemoryText(dir);
      expect(loaded.text).toBe('');
      expect(loaded.notes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('memoryDirFor 固定映射到项目 .modou/memory', () => {
    expect(memoryDirFor('/proj')).toBe(join('/proj', '.modou', 'memory'));
  });

  test('默认注入上限常量与指令文件同量级（32KB）', () => {
    expect(MEMORY_LOAD_LIMIT_BYTES).toBe(32 * 1024);
  });
});
