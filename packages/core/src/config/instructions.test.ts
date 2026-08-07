/**
 * 指令文件加载（T-081）离线测试。
 *
 * 覆盖：全局 → 项目根 → 子目录叠加顺序（含 git 边界语义）；AGENTS.md 优先于
 * CLAUDE.md（兼容）；无 git 时取最顶层含指令文件的目录；空文件落到兼容文件；
 * 32KB 上限截断 + notice（丢弃低优先级文件 / 截断单份内容）；来源路径头；
 * buildSystemPrompt extra 接入。
 *
 * 全部离线：临时 HOME / 项目目录注入，不读写真实用户目录。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultReadonlyTools } from '../tools/impl';
import { buildSystemPrompt } from '../prompt/system';
import {
  DEFAULT_INSTRUCTIONS_LIMIT_BYTES,
  loadInstructions,
} from './instructions';

// ---------------------------------------------------------------------------
// 测试辅助：临时目录树 + 写指令文件
// ---------------------------------------------------------------------------

let dirCount = 0;

/** 建一个隔离的临时目录树根（每次测试独立，afterEach 清理）。 */
function makeTempRoot(label: string): string {
  dirCount += 1;
  return mkdtempSync(join(tmpdir(), `modou-instr-${label}-${dirCount}-`));
}

/** 写一个文本文件（父目录自动创建；返回文件绝对路径）。 */
function writeText(root: string, rel: string, content: string): string {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

/** 建一个 .git 目录（git 仓库边界标记）。 */
function makeGitDir(root: string, rel: string): void {
  mkdirSync(join(root, rel), { recursive: true });
}

/** 断言文本里出现的顺序（最早出现的在前）。 */
function expectOrder(text: string, ordered: readonly string[]): void {
  let prev = -1;
  for (const needle of ordered) {
    const index = text.indexOf(needle);
    expect(index).toBeGreaterThan(prev);
    prev = index;
  }
}

// ---------------------------------------------------------------------------
// 叠加顺序与来源路径头
// ---------------------------------------------------------------------------

describe('loadInstructions：收集与拼接', () => {
  test('全局 → 项目根 → 子目录顺序拼接，越靠后越有效；各节带来源路径头', () => {
    const root = makeTempRoot('stack');
    try {
      const globalFile = writeText(
        root,
        '.modou/AGENTS.md',
        '全局规则：冷静审慎',
      );
      const projectFile = writeText(
        root,
        'proj/AGENTS.md',
        '根规则：TypeScript + Bun',
      );
      const subFile = writeText(
        root,
        'proj/packages/core/AGENTS.md',
        '子目录规则：核心包零 UI 依赖',
      );
      makeGitDir(root, 'proj/.git');

      const result = loadInstructions({
        homeDir: root,
        cwd: join(root, 'proj/packages/core'),
      });

      // 收集顺序：全局 → 根 → 子目录（files 与 text 中的位置一致）
      expect(result.files.map((f) => f.path)).toEqual([
        globalFile,
        projectFile,
        subFile,
      ]);
      expect(result.truncated).toBe(false);
      expect(result.notice).toBeUndefined();
      expect(result.dropped).toEqual([]);

      // 来源路径头：每份文件都有「来源：」头
      expect(result.text).toContain(`### 来源：${globalFile}`);
      expect(result.text).toContain(`### 来源：${projectFile}`);
      expect(result.text).toContain(`### 来源：${subFile}`);
      // 节标题在场
      expect(result.text).toContain('## 项目指令');
      // 顺序：全局在前、子目录在后
      expectOrder(result.text, [
        `### 来源：${globalFile}`,
        `### 来源：${projectFile}`,
        `### 来源：${subFile}`,
      ]);
      // 内容都进了文本
      expect(result.text).toContain('全局规则：冷静审慎');
      expect(result.text).toContain('根规则：TypeScript + Bun');
      expect(result.text).toContain('子目录规则：核心包零 UI 依赖');
      // 总量在 32KB 上限内
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
        DEFAULT_INSTRUCTIONS_LIMIT_BYTES,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('git 边界：仓库目录以上的 AGENTS.md 不属于本项目（不上收到 git 根之上）', () => {
    const root = makeTempRoot('gitbound');
    try {
      // 仓库根之上的 AGENTS.md（不应被收集）
      const aboveFile = writeText(
        root,
        'AGENTS.md',
        '仓库之上的规则：不该进来',
      );
      const projectFile = writeText(root, 'proj/AGENTS.md', '仓库根规则');
      makeGitDir(root, 'proj/.git');

      const result = loadInstructions({
        homeDir: root,
        cwd: join(root, 'proj/sub'),
      });

      expect(result.files.map((f) => f.path)).toEqual([projectFile]);
      expect(result.text).toContain(`### 来源：${projectFile}`);
      expect(result.text).not.toContain(`### 来源：${aboveFile}`);
      expect(result.text).not.toContain('仓库之上的规则');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('无 git 时取最顶层含指令文件的目录为项目根，收集其下各级', () => {
    const root = makeTempRoot('nogit');
    try {
      const topFile = writeText(root, 'AGENTS.md', '最顶层规则');
      const nestedFile = writeText(root, 'pkg/sub/AGENTS.md', '嵌套规则');
      // 注意：不建 .git——项目根应为最顶层含指令文件的目录

      const result = loadInstructions({
        homeDir: root,
        cwd: join(root, 'pkg/sub'),
      });

      expect(result.files.map((f) => f.path)).toEqual([topFile, nestedFile]);
      expectOrder(result.text, [
        `### 来源：${topFile}`,
        `### 来源：${nestedFile}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('没有任何指令文件时返回空文本（不报错、不截断）', () => {
    const root = makeTempRoot('empty');
    try {
      makeGitDir(root, 'proj/.git');
      const result = loadInstructions({
        homeDir: root,
        cwd: join(root, 'proj'),
      });
      expect(result.files).toEqual([]);
      expect(result.text).toBe('');
      expect(result.truncated).toBe(false);
      expect(result.dropped).toEqual([]);
      expect(result.notice).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AGENTS.md 优先于 CLAUDE.md（兼容）
// ---------------------------------------------------------------------------

describe('loadInstructions：AGENTS.md 优先 / CLAUDE.md 兼容', () => {
  test('同目录同时存在 AGENTS.md 与 CLAUDE.md 时只取 AGENTS.md', () => {
    const root = makeTempRoot('prefer');
    try {
      const agentsFile = writeText(root, 'proj/AGENTS.md', 'AGENTS 规则');
      writeText(root, 'proj/CLAUDE.md', 'CLAUDE 规则：不该出现');
      makeGitDir(root, 'proj/.git');

      const result = loadInstructions({
        homeDir: root,
        cwd: join(root, 'proj'),
      });

      expect(result.files.map((f) => f.path)).toEqual([agentsFile]);
      expect(result.text).toContain('AGENTS 规则');
      expect(result.text).not.toContain('CLAUDE 规则');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('只有 CLAUDE.md 时作为兼容层生效', () => {
    const root = makeTempRoot('claudeonly');
    try {
      const claudeFile = writeText(root, 'proj/CLAUDE.md', 'CLAUDE 兼容规则');
      makeGitDir(root, 'proj/.git');

      const result = loadInstructions({
        homeDir: root,
        cwd: join(root, 'proj'),
      });

      expect(result.files.map((f) => f.path)).toEqual([claudeFile]);
      expect(result.text).toContain('CLAUDE 兼容规则');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('AGENTS.md 为空时落到同目录的 CLAUDE.md', () => {
    const root = makeTempRoot('emptyagents');
    try {
      const agentsFile = writeText(root, 'proj/AGENTS.md', '   \n  ');
      const claudeFile = writeText(
        root,
        'proj/CLAUDE.md',
        '空 AGENTS 时的兼容规则',
      );
      makeGitDir(root, 'proj/.git');

      const result = loadInstructions({
        homeDir: root,
        cwd: join(root, 'proj'),
      });

      expect(result.files.map((f) => f.path)).toEqual([claudeFile]);
      expect(result.text).toContain('空 AGENTS 时的兼容规则');
      expect(result.text).not.toContain(agentsFile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 32KB 上限截断 + notice（不静默）
// ---------------------------------------------------------------------------

describe('loadInstructions：超限截断与告警', () => {
  test('总量超限时丢弃低优先级文件（全局层最先被丢），并发 notice 点名截断部分', () => {
    const root = makeTempRoot('trunc-drop');
    try {
      // 全局层内容最大、优先级最低——超限时应最先被丢弃
      const globalFile = writeText(root, '.modou/AGENTS.md', 'G'.repeat(800));
      const projectFile = writeText(root, 'proj/AGENTS.md', 'R'.repeat(100));
      const subFile = writeText(root, 'proj/pkg/AGENTS.md', 'S'.repeat(100));
      makeGitDir(root, 'proj/.git');

      const limitBytes = 1000;
      const result = loadInstructions({
        homeDir: root,
        cwd: join(root, 'proj/pkg'),
        limitBytes,
      });

      // 截断且不静默：notice 说明丢的是哪份（全局层）
      expect(result.truncated).toBe(true);
      expect(result.dropped).toEqual([globalFile]);
      expect(result.notice).toBeDefined();
      expect(result.notice).toContain(globalFile);
      // 保留了靠后的高优先级部分（根 + 子目录），全局层内容不再出现
      expect(result.files.map((f) => f.path)).toEqual([projectFile, subFile]);
      expect(result.text).toContain(`### 来源：${projectFile}`);
      expect(result.text).toContain(`### 来源：${subFile}`);
      expect(result.text).not.toContain(globalFile);
      expect(result.text).not.toContain('G'.repeat(800));
      // 硬上限：渲染文本不超过 limitBytes
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
        limitBytes,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('单份文件超过整个上限时保留其头部并加截断标记，notice 说明部分保留', () => {
    const root = makeTempRoot('trunc-single');
    try {
      const globalFile = writeText(root, '.modou/AGENTS.md', 'X'.repeat(2000));

      const limitBytes = 700;
      const result = loadInstructions({
        homeDir: root,
        cwd: join(root),
        limitBytes,
      });

      expect(result.truncated).toBe(true);
      // 无可丢弃的低优先级文件：内容被截断（保留头部 + 截断标记）
      expect(result.dropped).toEqual([]);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.truncated).toBe(true);
      expect(result.text).toContain(`### 来源：${globalFile}`);
      // 截断标记在场（模型知道信息不全，002 5.4「截断要出声」）
      expect(result.text).toContain('已截断');
      expect(result.notice).toBeDefined();
      expect(result.notice).toContain(globalFile);
      expect(result.notice).toContain('部分保留');
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
        limitBytes,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('全部放得下时不截断（truncated=false、无 notice）', () => {
    const root = makeTempRoot('nobudget');
    try {
      writeText(root, 'proj/AGENTS.md', '小规则');
      writeText(root, 'proj/pkg/AGENTS.md', '更小规则');
      makeGitDir(root, 'proj/.git');

      const result = loadInstructions({
        homeDir: root,
        cwd: join(root, 'proj/pkg'),
      });

      expect(result.truncated).toBe(false);
      expect(result.dropped).toEqual([]);
      expect(result.notice).toBeUndefined();
      expect(result.text).toContain('小规则');
      expect(result.text).toContain('更小规则');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt 接入（extra 拼在提示词末尾）
// ---------------------------------------------------------------------------

describe('loadInstructions：接入 buildSystemPrompt', () => {
  test('渲染结果作为 extra 注入系统提示词（含小节标题与来源头，拼在末尾）', () => {
    const root = makeTempRoot('prompt');
    try {
      const projectFile = writeText(
        root,
        'proj/AGENTS.md',
        '本仓库遵循既有约定',
      );
      makeGitDir(root, 'proj/.git');

      const loaded = loadInstructions({
        homeDir: root,
        cwd: join(root, 'proj'),
      });
      const prompt = buildSystemPrompt({
        tools: defaultReadonlyTools(),
        extra: loaded.text,
      });

      expect(prompt).toContain('## 项目指令');
      expect(prompt).toContain(`### 来源：${projectFile}`);
      expect(prompt).toContain('本仓库遵循既有约定');
      // extra 拼在提示词末尾
      expect(prompt.endsWith(loaded.text)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
