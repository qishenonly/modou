import { describe, expect, test } from 'bun:test';
import { parseAgentMarkdown } from './parse';

/**
 * 自定义 agents 解析（0.17.0 T-170）：`.modou/agents/*.md` frontmatter + 角色正文。
 * 覆盖：完整字段解析 / 缺省字段回落 / 非法文件拒绝（null）。
 */
describe('parseAgentMarkdown', () => {
  test('解析完整字段：name / description / allowedTools / model / 正文', () => {
    const agent = parseAgentMarkdown(
      `---
name: reviewer
description: 资深代码审查专家
allowedTools: read,grep,glob,bash
model: gpt-4o
---
你是一名资深代码审查专家。审查时：
1. 先看改动面；
2. 只报真实问题。`,
      '/proj/.modou/agents/reviewer.md',
    );
    expect(agent).not.toBeNull();
    expect(agent?.name).toBe('reviewer');
    expect(agent?.description).toBe('资深代码审查专家');
    expect(agent?.allowedTools).toEqual(['read', 'grep', 'glob', 'bash']);
    expect(agent?.model).toBe('gpt-4o');
    expect(agent?.systemPrompt).toContain('资深代码审查专家');
    expect(agent?.systemPrompt).toContain('只报真实问题');
    expect(agent?.file).toBe('/proj/.modou/agents/reviewer.md');
  });

  test('allowedTools 未声明 = 空数组（派发时继承父代理完整工具集）', () => {
    const agent = parseAgentMarkdown(
      `---
name: debugger
description: 调试排查
---
你是调试专家。`,
      '/proj/.modou/agents/debugger.md',
    );
    expect(agent).not.toBeNull();
    expect(agent?.allowedTools).toEqual([]);
    expect(agent?.model).toBeUndefined();
  });

  test('允许 allowedTools 块状列表（- item 逐行）与 model 缺省', () => {
    const agent = parseAgentMarkdown(
      `---
name: researcher
description: 调研
allowedTools:
- read
- grep
- glob
---
只做调研不改动。`,
      '/proj/.modou/agents/researcher.md',
    );
    expect(agent?.allowedTools).toEqual(['read', 'grep', 'glob']);
  });

  test('无 frontmatter 返回 null', () => {
    expect(parseAgentMarkdown('纯正文没有元信息', '/p/a.md')).toBeNull();
  });

  test('缺 name 返回 null', () => {
    expect(
      parseAgentMarkdown(
        `---
description: 缺名字
---
正文`,
        '/p/a.md',
      ),
    ).toBeNull();
  });

  test('缺 description 返回 null', () => {
    expect(
      parseAgentMarkdown(
        `---
name: lonely
---
正文`,
        '/p/a.md',
      ),
    ).toBeNull();
  });

  test('缺正文返回 null', () => {
    expect(
      parseAgentMarkdown(
        `---
name: empty
description: 没正文
---
`,
        '/p/a.md',
      ),
    ).toBeNull();
  });

  test('model 空串按未声明处理', () => {
    const agent = parseAgentMarkdown(
      `---
name: a
description: b
model:
---
正文`,
      '/p/a.md',
    );
    expect(agent?.model).toBeUndefined();
  });

  test('unknown 字段忽略不报错（模型/用户手写容错）', () => {
    const agent = parseAgentMarkdown(
      `---
name: tolerant
description: 容错
aliases: x,y
---
正文`,
      '/p/a.md',
    );
    expect(agent?.name).toBe('tolerant');
  });
});
