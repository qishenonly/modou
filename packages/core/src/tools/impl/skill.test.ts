/**
 * Skill 工具与渐进式披露（T-152）离线测试。
 *
 * 覆盖（0.15.0-kickoff 3.1 / ADR 0014）：
 * - 渐进式披露：系统提示词的技能段只含 name + description（正文不进清单）；
 * - Skill 调用注入正文：命中时 forModel 含技能正文 + 附带文件清单 +
 *   allowed-tools 声明，ok:true；
 * - 未知技能错误即数据：resolve 未命中返回 ok:false 并列出可用技能名；
 * - 无可用技能：默认实例（空解析器）返回「没有可用技能」失败。
 *
 * 全部离线：不访问网络、不依赖真实模型。
 */
import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from '../../prompt/system';
import { ToolRegistry } from '../registry';
import { createSkillTool, skillSchema, skillTool } from './skill';
import type { SkillInfo } from './skill';

const EXAMPLE: SkillInfo = {
  name: 'code-review',
  description: '逐文件审查代码改动',
  directory: '/tmp/skills/code-review',
  body: '# 代码审查\n\n先读 diff，再逐文件核对。',
  files: ['scripts/check.sh', 'notes.md'],
  allowedTools: ['read', 'grep', 'bash'],
};

describe('渐进式披露：技能清单常驻系统提示词', () => {
  test('清单只含 name + description，正文 / 附带文件不进清单', () => {
    const prompt = buildSystemPrompt({
      tools: new ToolRegistry(),
      skills: [
        { name: 'code-review', description: '逐文件审查代码改动' },
        { name: 'write-tests', description: '按三明治结构写测试' },
      ],
    });
    expect(prompt).toContain('可用技能');
    expect(prompt).toContain('- code-review：逐文件审查代码改动');
    expect(prompt).toContain('- write-tests：按三明治结构写测试');
    // 正文不常驻：清单里不出现正文内容
    expect(prompt).not.toContain('先读 diff');
    expect(prompt).not.toContain('check.sh');
    // 明确触发方式：模型判断 + skill 工具加载
    expect(prompt).toContain('skill 工具');
    expect(prompt).toContain('未列出的技能不存在');
  });

  test('无 skills 时不渲染技能段', () => {
    const prompt = buildSystemPrompt({ tools: new ToolRegistry() });
    expect(prompt).not.toContain('可用技能');
    expect(prompt).not.toContain('skill 工具');
  });

  test('技能段位于工具段之后、编辑纪律之前（编号连续）', () => {
    const prompt = buildSystemPrompt({
      tools: new ToolRegistry(),
      skills: [{ name: 's', description: 'd' }],
    });
    const toolsIndex = prompt.indexOf('## 二、可用工具');
    const skillsIndex = prompt.indexOf('## 三、可用技能');
    const outputIndex = prompt.indexOf('## 四、输出期待');
    expect(toolsIndex).toBeGreaterThan(-1);
    expect(skillsIndex).toBeGreaterThan(toolsIndex);
    expect(outputIndex).toBeGreaterThan(skillsIndex);
  });
});

describe('createSkillTool（正文注入 / 未知技能错误即数据）', () => {
  test('命中：注入正文 + 附带文件清单 + allowed-tools 声明，ok:true', async () => {
    const tool = createSkillTool({
      resolve: (name) => (name === 'code-review' ? EXAMPLE : undefined),
      names: () => ['code-review'],
    });
    const outcome = await tool.execute(
      { name: 'code-review' },
      { signal: new AbortController().signal },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.forModel).toContain('# 技能：code-review');
    expect(outcome.forModel).toContain('# 代码审查');
    expect(outcome.forModel).toContain('先读 diff');
    expect(outcome.forModel).toContain('- scripts/check.sh');
    expect(outcome.forModel).toContain('- notes.md');
    expect(outcome.forModel).toContain('read、grep、bash');
    expect(outcome.forModel).toContain('来源目录：/tmp/skills/code-review');
  });

  test('无附带文件时注入文本不含文件段', async () => {
    const tool = createSkillTool({
      resolve: (name) =>
        name === 'minimal'
          ? { name: 'minimal', description: '', body: '正文内容' }
          : undefined,
    });
    const outcome = await tool.execute(
      { name: 'minimal' },
      { signal: new AbortController().signal },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.forModel).toContain('正文内容');
    expect(outcome.forModel).not.toContain('附带文件');
  });

  test('未知技能：ok:false 并列出可用技能名（错误即数据）', async () => {
    const tool = createSkillTool({
      resolve: () => undefined,
      names: () => ['code-review', 'write-tests'],
    });
    const outcome = await tool.execute(
      { name: 'no-such-skill' },
      { signal: new AbortController().signal },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('未知技能 "no-such-skill"');
    expect(outcome.forModel).toContain('code-review、write-tests');
    expect(outcome.forModel).toContain('不要臆造技能名');
  });

  test('无可用技能：默认实例返回「当前没有可用技能」失败', async () => {
    const outcome = await skillTool.execute(
      { name: 'anything' },
      { signal: new AbortController().signal },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('当前没有可用技能');
  });

  test('参数校验：空技能名被 schema 拒绝', async () => {
    const parsed = skillSchema.safeParse({ name: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(String(parsed.error.message)).toContain('name 不能为空字符串');
    }
  });
});
