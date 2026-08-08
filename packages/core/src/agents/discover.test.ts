import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAgents } from './discover';

/**
 * 自定义 agents 发现与加载（0.17.0 T-170）：
 * 两级发现（全局 < 项目，项目覆盖全局同名）+ 非法文件跳过记录。
 */
describe('discoverAgents', () => {
  test('项目级 `.modou/agents/*.md` 被加载', () => {
    const home = mkdtempSync(join(tmpdir(), 'agents-home-'));
    const project = mkdtempSync(join(tmpdir(), 'agents-proj-'));
    const dir = join(project, '.modou', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'reviewer.md'),
      `---
name: reviewer
description: 审查
---
你是审查专家。`,
    );
    writeFileSync(
      join(dir, 'debugger.md'),
      `---
name: debugger
description: 调试
allowedTools: read,grep,glob,bash
---
你是调试专家。`,
    );
    const { agents, skipped } = discoverAgents({
      homeDir: home,
      projectRoot: project,
    });
    expect(skipped).toEqual([]);
    expect(agents.map((a) => a.name)).toEqual(['debugger', 'reviewer']);
    expect(agents[0].level).toBe('project');
    expect(agents[0].allowedTools).toEqual(['read', 'grep', 'glob', 'bash']);
  });

  test('全局 `~/.modou/agents/` 也被加载（低优先级）', () => {
    const home = mkdtempSync(join(tmpdir(), 'agents-home-'));
    const project = mkdtempSync(join(tmpdir(), 'agents-proj-'));
    mkdirSync(join(home, '.modou', 'agents'), { recursive: true });
    writeFileSync(
      join(home, '.modou', 'agents', 'global-agent.md'),
      `---
name: global-agent
description: 全局角色
---
我是全局角色。`,
    );
    const { agents } = discoverAgents({ homeDir: home, projectRoot: project });
    expect(agents.map((a) => a.name)).toEqual(['global-agent']);
    expect(agents[0].level).toBe('global');
  });

  test('项目覆盖全局同名 agent', () => {
    const home = mkdtempSync(join(tmpdir(), 'agents-home-'));
    const project = mkdtempSync(join(tmpdir(), 'agents-proj-'));
    mkdirSync(join(home, '.modou', 'agents'), { recursive: true });
    writeFileSync(
      join(home, '.modou', 'agents', 'role.md'),
      `---
name: role
description: 全局版
---
全局版正文。`,
    );
    mkdirSync(join(project, '.modou', 'agents'), { recursive: true });
    writeFileSync(
      join(project, '.modou', 'agents', 'role.md'),
      `---
name: role
description: 项目版
allowedTools: read
---
项目版正文。`,
    );
    const { agents } = discoverAgents({ homeDir: home, projectRoot: project });
    expect(agents).toHaveLength(1);
    expect(agents[0].level).toBe('project');
    expect(agents[0].description).toBe('项目版');
    expect(agents[0].allowedTools).toEqual(['read']);
  });

  test('非法文件（缺 name/description/正文）跳过并记录，不静默', () => {
    const home = mkdtempSync(join(tmpdir(), 'agents-home-'));
    const project = mkdtempSync(join(tmpdir(), 'agents-proj-'));
    const dir = join(project, '.modou', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'bad-missing-name.md'),
      `---\ndescription: 没名字\n---\n正文`,
    );
    writeFileSync(
      join(dir, 'bad-no-body.md'),
      `---\nname: x\ndescription: y\n---\n`,
    );
    writeFileSync(
      join(dir, 'ok.md'),
      `---\nname: ok\ndescription: 好的\n---\n正文`,
    );
    // 非 .md 文件忽略
    writeFileSync(join(dir, 'notes.txt'), '不是 agent');
    const { agents, skipped } = discoverAgents({
      homeDir: home,
      projectRoot: project,
    });
    expect(agents.map((a) => a.name)).toEqual(['ok']);
    expect([...skipped].sort()).toEqual([
      'bad-missing-name.md',
      'bad-no-body.md',
    ]);
  });

  test('无 agents 目录返回空（不抛错）', () => {
    const home = mkdtempSync(join(tmpdir(), 'agents-home-'));
    const project = mkdtempSync(join(tmpdir(), 'agents-proj-'));
    const { agents, skipped } = discoverAgents({
      homeDir: home,
      projectRoot: project,
    });
    expect(agents).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
