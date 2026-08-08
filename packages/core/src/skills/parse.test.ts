/**
 * SKILL.md 解析（T-150）离线测试。
 *
 * 覆盖（Agent Skills 开放标准的解析面）：
 * - frontmatter 解析：name / description / allowed-tools 三种写法（块状列表、
 *   空格分隔字符串、流式列表）与 allowedTools 别名；
 * - 缺字段容错：无 frontmatter（整份即正文）、name 缺失回落目录名、description
 *   缺失记为 ''、无闭合分隔符不吞正文、空 frontmatter；
 * - 附带文件清单：递归、排序稳定、跳过 SKILL.md 本身与隐藏文件。
 *
 * 全部离线：只读临时目录，不访问网络。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSkillFiles, parseSkillMarkdown, readSkillMarkdown } from './parse';

describe('parseSkillMarkdown（frontmatter + 正文）', () => {
  test('标准 frontmatter：name / description / allowed-tools（块状列表）', () => {
    const markdown = [
      '---',
      'name: my-skill',
      'description: 分步完成某类任务',
      'allowed-tools:',
      '  - read',
      '  - grep',
      '---',
      '# 正文',
      '',
      '第一步：定位。',
    ].join('\n');
    const parsed = parseSkillMarkdown(markdown);
    expect(parsed.name).toBe('my-skill');
    expect(parsed.description).toBe('分步完成某类任务');
    expect(parsed.allowedTools).toEqual(['read', 'grep']);
    expect(parsed.body).toBe('# 正文\n\n第一步：定位。');
  });

  test('allowed-tools 空格分隔与流式列表两种写法', () => {
    expect(
      parseSkillMarkdown('---\nname: a\nallowed-tools: Read Grep\n---\nbody')
        .allowedTools,
    ).toEqual(['Read', 'Grep']);
    expect(
      parseSkillMarkdown('---\nname: b\nallowed-tools: [read, glob]\n---\nbody')
        .allowedTools,
    ).toEqual(['read', 'glob']);
  });

  test('allowedTools 驼峰别名同样接受（任务口径）', () => {
    const parsed = parseSkillMarkdown(
      '---\nname: c\ndescription: d\nallowedTools:\n  - bash\n---\nbody',
    );
    expect(parsed.allowedTools).toEqual(['bash']);
  });

  test('带引号的值剥引号', () => {
    const parsed = parseSkillMarkdown(
      '---\nname: "quoted-name"\ndescription: \'带引号的描述\'\n---\nbody',
    );
    expect(parsed.name).toBe('quoted-name');
    expect(parsed.description).toBe('带引号的描述');
  });

  test('缺字段容错：无 frontmatter 时整份内容即正文，name 回落目录名', () => {
    const parsed = parseSkillMarkdown(
      '# 只有正文\n\n没有 frontmatter。',
      'dir-name',
    );
    expect(parsed.name).toBe('dir-name');
    expect(parsed.description).toBe('');
    expect(parsed.allowedTools).toEqual([]);
    expect(parsed.body).toBe('# 只有正文\n\n没有 frontmatter。');
    expect(parsed.frontmatter.name).toBeUndefined();
  });

  test('缺字段容错：无闭合分隔符视为无 frontmatter（不吞正文）', () => {
    const markdown = '---\nname: broken\n# 后面没有闭合 ---\n正文内容。';
    const parsed = parseSkillMarkdown(markdown, 'fallback');
    // 首行是 `---` 但找不到闭合 → 整份视为正文，frontmatter 为空
    expect(parsed.body).toBe(markdown.trim());
    expect(parsed.name).toBe('fallback');
  });

  test('缺字段容错：frontmatter 缺 name 时回落目录名、缺 description 记为空', () => {
    const parsed = parseSkillMarkdown(
      '---\ndescription: 只有描述\n---\n正文',
      'dir-fallback',
    );
    expect(parsed.name).toBe('dir-fallback');
    expect(parsed.description).toBe('只有描述');
  });

  test('缺字段容错：空 frontmatter 与空文件', () => {
    const empty = parseSkillMarkdown('', 'empty-name');
    expect(empty.name).toBe('empty-name');
    expect(empty.description).toBe('');
    expect(empty.body).toBe('');
    const blankFrontmatter = parseSkillMarkdown('---\n---\n正文');
    expect(blankFrontmatter.name).toBe('');
    expect(blankFrontmatter.body).toBe('正文');
  });

  test('标准外的字段忽略（license / metadata 等不构成负担）', () => {
    const parsed = parseSkillMarkdown(
      '---\nname: x\nlicense: MIT\nmetadata:\n  author: bob\n---\nbody',
    );
    expect(parsed.name).toBe('x');
    expect(parsed.description).toBe('');
    expect(parsed.body).toBe('body');
  });

  test('CRLF 行尾与 BOM 容错', () => {
    const parsed = parseSkillMarkdown(
      '﻿---\r\nname: crlf-skill\r\ndescription: CRLF 描述\r\n---\r\n正文\r\n',
    );
    expect(parsed.name).toBe('crlf-skill');
    expect(parsed.description).toBe('CRLF 描述');
    expect(parsed.body).toBe('正文');
  });
});

describe('listSkillFiles / readSkillMarkdown（附带文件清单）', () => {
  test('递归列出 SKILL.md 之外的附带文件，排序稳定', () => {
    const dir = mkdtempSync(join(tmpdir(), 'modou-skill-files-'));
    try {
      const scripts = join(dir, 'scripts');
      mkdirSync(scripts, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: s\n---\nbody');
      writeFileSync(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\n');
      writeFileSync(join(dir, 'scripts', 'helper.js'), '');
      writeFileSync(join(dir, 'notes.txt'), 'note');
      writeFileSync(join(dir, '.hidden'), 'x');

      expect(listSkillFiles(dir)).toEqual([
        'notes.txt',
        'scripts/helper.js',
        'scripts/run.sh',
      ]);
      // SKILL.md 本身不进清单
      expect(listSkillFiles(dir)).not.toContain('SKILL.md');
      // 读取 SKILL.md 原文
      expect(readSkillMarkdown(dir)).toBe('---\nname: s\n---\nbody');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('不存在的目录返回空清单 / null 读取', () => {
    const dir = join(tmpdir(), 'modou-no-such-skill-dir');
    expect(listSkillFiles(dir)).toEqual([]);
    expect(readSkillMarkdown(dir)).toBeNull();
  });

  test('空目录（无 SKILL.md）同样返回空清单', () => {
    const dir = mkdtempSync(join(tmpdir(), 'modou-empty-skill-'));
    try {
      expect(listSkillFiles(dir)).toEqual([]);
      expect(readSkillMarkdown(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
