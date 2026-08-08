import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  expandCommandPlaceholders,
  loadCustomCommands,
  parseCommandFrontmatter,
} from './commands';

describe('自定义斜杠命令（T-114 frontmatter 解析）', () => {
  test('解析完整 frontmatter：name/description/allowedTools/model + 正文', () => {
    const command = parseCommandFrontmatter(`---
name: fix-lint
description: 修复 lint 错误
allowedTools: read,grep,glob,write,edit,bash
model: gpt-4o
---
请修复 lint 错误：先运行 $1 定位，再修复并验证。`);
    expect(command).toEqual({
      name: 'fix-lint',
      description: '修复 lint 错误',
      allowedTools: ['read', 'grep', 'glob', 'write', 'edit', 'bash'],
      model: 'gpt-4o',
      prompt: '请修复 lint 错误：先运行 $1 定位，再修复并验证。',
    });
  });

  test('可选字段缺省：无 allowedTools / model', () => {
    const command = parseCommandFrontmatter(`---
name: greet
description: 打招呼
---
你好，$1！`);
    expect(command).toEqual({
      name: 'greet',
      description: '打招呼',
      prompt: '你好，$1！',
    });
  });

  test('容错：frontmatter 内注释行 / 空行跳过；allowedTools 带空格', () => {
    const command = parseCommandFrontmatter(`---
# 用户自定义命令
name:  refactor

description: 重构
allowedTools: read , glob , write
---
重构 $1`);
    expect(command).not.toBeNull();
    expect(command!.name).toBe('refactor');
    expect(command!.allowedTools).toEqual(['read', 'glob', 'write']);
  });

  test('无效文件返回 null：无 frontmatter / 缺 name / 缺正文', () => {
    expect(parseCommandFrontmatter('没有 frontmatter 的普通 md')).toBeNull();
    expect(
      parseCommandFrontmatter(`---
description: 缺 name
---
正文`),
    ).toBeNull();
    expect(
      parseCommandFrontmatter(`---
name: x
description: 缺正文
---`),
    ).toBeNull();
  });

  test('expandCommandPlaceholders：$1/$2/$@/$0/$$ 替换', () => {
    const prompt =
      '参数一=$1 参数二=$2 全部=$@ 原始=$0 转义=$$ 缺失=$9 未知=$X';
    expect(expandCommandPlaceholders(prompt, 'alpha beta gamma')).toBe(
      '参数一=alpha 参数二=beta 全部=alpha beta gamma 原始=alpha beta gamma 转义=$ 缺失= 未知=$X',
    );
    // 无参数：占位替换为空串
    expect(expandCommandPlaceholders('你好 $1', undefined)).toBe('你好 ');
  });
});

describe('loadCustomCommands（T-114 目录加载）', () => {
  test('加载 `.modou/commands/*.md`，跳过非法与内置同名', async () => {
    const root = mkdtempSync(join(tmpdir(), 'modou-commands-'));
    try {
      const dir = join(root, '.modou', 'commands');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'a.md'),
        `---
name: a
description: A
---
任务 A：$1`,
        'utf8',
      );
      writeFileSync(
        join(dir, 'b.md'),
        `---
name: b
description: B
allowedTools: read
---
任务 B`,
        'utf8',
      );
      // 与内置冲突：/plan 是内置命令 → 跳过
      writeFileSync(
        join(dir, 'plan.md'),
        `---
name: plan
description: 与内置冲突
---
覆盖内置`,
        'utf8',
      );
      // 非法（缺 name）→ 跳过
      writeFileSync(
        join(dir, 'bad.md'),
        `---
description: 缺 name
---
正文`,
        'utf8',
      );
      // 非 .md 文件 → 忽略
      writeFileSync(join(dir, 'notes.txt'), 'not a command', 'utf8');

      const result = await loadCustomCommands(root);
      expect(result.commands.map((c) => c.name)).toEqual(['a', 'b']);
      expect(result.commands[1].allowedTools).toEqual(['read']);
      expect([...result.skipped].sort()).toEqual(['bad.md', 'plan.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('目录不存在返回空列表', async () => {
    const root = mkdtempSync(join(tmpdir(), 'modou-commands-'));
    try {
      const result = await loadCustomCommands(root);
      expect(result.commands).toEqual([]);
      expect(result.skipped).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
