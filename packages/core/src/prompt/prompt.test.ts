import { describe, expect, test } from 'bun:test';
import { defaultReadonlyTools, defaultWriteTools } from '../tools/impl';
import { globTool } from '../tools/impl/glob';
import { grepTool } from '../tools/impl/grep';
import { readTool } from '../tools/impl/read';
import { ToolRegistry } from '../tools/registry';
import { buildSystemPrompt } from './system';

describe('buildSystemPrompt（T-023 系统提示词首版）', () => {
  test('身份段：modou 身份与行为准则（照线干活、不越界、审批边界）', () => {
    const prompt = buildSystemPrompt({ tools: defaultReadonlyTools() });
    expect(prompt).toContain('你是 modou');
    expect(prompt).toContain('照线干活');
    expect(prompt).toContain('不越界');
    // 0.3.0 语义：有读与写/执行工具，写入与命令执行需经审批
    expect(prompt).toContain('写入/执行工具');
    expect(prompt).toContain('需经用户审批');
    expect(prompt).toContain('被拒绝时按拒绝提示调整方案');
    expect(prompt).toContain('不要换写法反复触发审批');
    expect(prompt).toContain('绝不编造');
  });

  test('搜索优先段：先 Glob/Grep 定位，再 Read 具体文件', () => {
    const prompt = buildSystemPrompt({ tools: defaultReadonlyTools() });
    expect(prompt).toContain('搜索优先策略');
    expect(prompt).toContain('先 Glob/Grep 定位');
    expect(prompt).toContain('不要盲目读整个仓库');
    // Grep 无匹配时的换策略方向
    expect(prompt).toContain('ignoreCase=true');
    expect(prompt).toContain('更宽泛的 pattern');
    // Read 分页续读
    expect(prompt).toContain('offset 继续分页续读');
    // 信息不足继续搜索而不是瞎猜
    expect(prompt).toContain('继续搜索');
    expect(prompt).toContain('瞎猜');
  });

  test('工具说明：每个注册工具的名称与描述都在提示词里', () => {
    const prompt = buildSystemPrompt({ tools: defaultReadonlyTools() });
    expect(prompt).toContain('### read');
    expect(prompt).toContain('### grep');
    expect(prompt).toContain('### glob');
    // 描述与 read.ts / grep.ts / glob.ts 的定义一致
    expect(prompt).toContain('读取本地文件内容');
    expect(prompt).toContain('用正则表达式在文件或目录中搜索文本');
    expect(prompt).toContain('按 glob 模式枚举目录下的文件');
  });

  test('JSON Schema：每个工具的参数 schema 片段渲染进提示词', () => {
    const prompt = buildSystemPrompt({ tools: defaultReadonlyTools() });
    expect(prompt).toContain('"type": "object"');
    expect(prompt).toContain('"properties"');
    // read：path / offset / limit
    expect(prompt).toContain('"path"');
    expect(prompt).toContain('"offset"');
    expect(prompt).toContain('"limit"');
    // grep：ignoreCase；glob/grep：maxResults
    expect(prompt).toContain('"ignoreCase"');
    expect(prompt).toContain('"maxResults"');
  });

  test('未注册工具不出现（不存在即不可用）', () => {
    const prompt = buildSystemPrompt({ tools: defaultReadonlyTools() });
    // 常见的「未注册」工具（写 / 执行 / 通用测试工具）都不该出现在提示词里
    expect(prompt).not.toContain('### bash');
    expect(prompt).not.toContain('### edit');
    expect(prompt).not.toContain('### write');
    expect(prompt).not.toContain('### echo');
  });

  test('0.3.0 写工具集（defaultWriteTools）：write / edit / bash 全部声明给模型', () => {
    const prompt = buildSystemPrompt({ tools: defaultWriteTools() });
    expect(prompt).toContain('### read');
    expect(prompt).toContain('### grep');
    expect(prompt).toContain('### glob');
    expect(prompt).toContain('### write');
    expect(prompt).toContain('### edit');
    expect(prompt).toContain('### bash');
  });

  test('编辑纪律段（T-034）：先 Read 再 Edit、带足上下文、失败按诊断调整、改完自行验证、Bash 独立子进程', () => {
    const prompt = buildSystemPrompt({ tools: defaultWriteTools() });
    expect(prompt).toContain('编辑纪律');
    expect(prompt).toContain('先 Read 再 Edit');
    expect(prompt).toContain('带足上下文');
    expect(prompt).toContain('使 old_string 唯一');
    expect(prompt).toContain('最相近片段');
    expect(prompt).toContain('不要瞎猜');
    expect(prompt).toContain('改完自行验证');
    expect(prompt).toContain('测试 / 构建');
    expect(prompt).toContain('独立子进程');
    expect(prompt).toContain('cwd');
  });

  test('按注册表生成：只注册 read 时，只出现 read 的工具说明', () => {
    const prompt = buildSystemPrompt({
      tools: new ToolRegistry().register(readTool),
    });
    expect(prompt).toContain('### read');
    expect(prompt).not.toContain('### grep');
    expect(prompt).not.toContain('### glob');
  });

  test('确定性：同一注册表两次构建输出一致', () => {
    const registry = defaultReadonlyTools();
    const first = buildSystemPrompt({ tools: registry });
    const second = buildSystemPrompt({ tools: registry });
    expect(second).toBe(first);
  });

  test('确定性：注册顺序不影响输出（按工具名排序）', () => {
    const shuffled = new ToolRegistry()
      .register(globTool)
      .register(readTool)
      .register(grepTool);
    expect(buildSystemPrompt({ tools: shuffled })).toBe(
      buildSystemPrompt({ tools: defaultReadonlyTools() }),
    );
  });

  test('空注册表：明确提示本次会话没有可用工具', () => {
    const prompt = buildSystemPrompt({ tools: new ToolRegistry() });
    expect(prompt).toContain('没有可用工具');
    expect(prompt).not.toContain('### ');
  });

  test('extra 追加段拼在提示词末尾', () => {
    const extra = '项目指令：本仓库是 TS + Bun monorepo，请遵循既有约定。';
    const prompt = buildSystemPrompt({
      tools: defaultReadonlyTools(),
      extra,
    });
    expect(prompt.endsWith(extra)).toBe(true);
  });

  test('输出期待段：引用文件路径与行号、以事实为依据', () => {
    const prompt = buildSystemPrompt({ tools: defaultReadonlyTools() });
    expect(prompt).toContain('文件路径与行号');
    expect(prompt).toContain('以事实为依据');
    expect(prompt).toContain('不臆测');
  });
});
