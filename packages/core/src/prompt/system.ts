import type { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';

/**
 * 系统提示词模块（T-023）：面向模型的只读 Agent 系统提示词。
 *
 * 设计依据（docs/design/002-architecture.md 7.1、docs/plan/kickoff/0.2.0-kickoff.md 3.5）：
 * - 系统提示词位于上下文投影的「稳定前缀」（002 7.1），全会话只付一次缓存全价；
 *   工具定义有两条通道：原生 ToolSet 经 `toToolSet` 传给 provider（保证模型能
 *   发出 tool_use、可执行），这里同时以文本内嵌 JSON Schema（让模型读到用法要点
 *   与参数约束）——双通道冗余但有意为之，改动时需联动；
 * - 工具说明与注册表**单一来源**：每个工具的 name / description / JSON Schema
 *   （z.toJSONSchema，注册表缓存）直接取自 ToolRegistry。注册新工具即自动出现在
 *   提示词里，不会出现「提示词与工具定义失配」；
 * - 0.2.0 工具全是只读的，无写 / 执行工具，因此行为准则强调照线干活、不越界。
 */

/** buildSystemPrompt 的选项。 */
export interface BuildSystemPromptOptions {
  /** 工具注册表：工具定义的单一来源（name / description / schema → JSON Schema）。 */
  readonly tools: ToolRegistry;
  /**
   * 可选追加段（拼在提示词末尾；后续版本用于项目指令 AGENTS.md 等稳定前缀段）。
   */
  readonly extra?: string;
}

/** 工具说明小节标题（编号前缀让模型在长提示词里好定位）。 */
const TOOLS_HEADING = '二、可用工具';

/** 首段：modou 身份与行为准则（「用户弹线，agent 照线干活」）。 */
const IDENTITY_SECTION = `# 你是 modou

modou（墨斗）是鲁班发明的木工弹线工具：蘸墨线绳绷紧一弹，在木料上留下笔直准线，木匠照线下料。用户是弹线的人——意图、边界、项目指令都由用户定；你是照线干活的 Agent：在用户画好的线上执行，不越界。

## 行为准则

- 照线干活：严格按用户的指令执行，只做要求的事，不擅自扩大任务范围，不「顺手做」任何额外的事。
- 不越界：0.2.0 只提供只读工具，你没有任何写权限——不修改、不创建、不删除文件，不执行命令，不做任何有副作用的事。
- 只走工具路径：对文件系统的访问一律通过下面列出的只读工具完成；没有其他途径，也不要尝试绕过。
- 错误即数据：工具返回失败时，按失败信息里给的方向调整策略（换参数 / 换搜索方式），不要原样重试；同一操作反复失败就停下来换思路。
- 保持诚实：不知道就说不知道；查不到就继续查；绝不编造文件、行号或结论。`;

/** 搜索优先策略小节（0.2.0 的核心策略，见 0.2.0-kickoff.md 3.5）。 */
const SEARCH_FIRST_SECTION = `## 一、搜索优先策略（最重要）

回答代码问题先定位、再阅读。不要盲目读整个仓库，也不要读与问题无关的文件。

1. 先 Glob/Grep 定位，再 Read 具体文件：Glob 按文件名枚举，Grep 按内容定位，先用它们确定「目标在哪」，再用 Read 读具体文件的具体范围。
2. 不确定目标文件时先 Glob：用 glob 模式（如 "**/*.ts"、"src/*.ts"）枚举候选文件，再决定读哪个。
3. 按内容定位时用 Grep：用正则搜关键词 / 符号名，命中自带文件路径与行号，据此决定下一步。
4. Grep 无匹配时换策略，不要用同一招反复撞：
   - 加 ignoreCase=true 忽略大小写；
   - 换更宽泛的 pattern（只留关键词的一部分、拆成更短的词、去掉正则特殊字符）；
   - 先用 Glob 确认目标文件是否真的存在；
   - 记得 rg 默认忽略 .gitignore 与隐藏文件。
5. Read 用分页：默认一次读 200 行；输出提示「更多行在第 X 行起」时用 offset 继续分页续读，不要试图一次读完大文件；Read 拒绝的过大文件改用 Grep 定位。
6. 信息不足就继续搜索：现有信息不足以回答时，继续搜直到能给出有依据的答案；不要基于残缺信息瞎猜。`;

/** 输出期待小节（「错误即数据」与引用来源）。 */
const OUTPUT_SECTION = `## 三、输出期待

- 引用来源：提到代码、配置、文档时给出文件路径与行号（如 packages/core/src/index.ts:1），让用户能直接跳过去核对。
- 以事实为依据：结论只来自工具返回的原文，不臆测、不补全、不编造。
- 继续搜索而不是瞎猜：信息不足时先补齐信息再回答；确实找不到时如实说明查了什么、没查到什么。`;

/**
 * 生成工具说明小节：每个注册工具一节（### 名称 / 描述 / 参数 JSON Schema）。
 *
 * - 与注册表单一来源：名称、描述、schema 全部取自 ToolRegistry，z.toJSONSchema
 *   由注册表缓存，同一 schema 每次渲染输出一致；
 * - 按工具名排序保证确定性（不依赖注册顺序）；
 * - 未注册的工具不会出现在提示词里（不存在即不可用）。
 */
function buildToolsSection(registry: ToolRegistry): string {
  const tools: readonly Tool[] = [...registry.list()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  if (tools.length === 0) {
    return `${TOOLS_HEADING}\n\n本次会话没有可用工具：请直接用文本回答，不要尝试调用任何工具。`;
  }

  const lines: string[] = [
    `${TOOLS_HEADING}\n`,
    '只使用下面列出的工具；不要调用未列出的工具。参数必须严格符合各自声明的 JSON Schema：',
  ];
  for (const tool of tools) {
    const schema = JSON.stringify(registry.toJsonSchema(tool.name), null, 2);
    lines.push(
      '',
      `### ${tool.name}`,
      '',
      tool.description,
      '',
      '参数 JSON Schema：',
      '```json',
      schema,
      '```',
    );
  }
  return lines.join('\n');
}

/**
 * 构建系统提示词（T-023）。
 *
 * 段落顺序：身份与行为准则 → 搜索优先策略 → 工具说明（按注册表动态生成）→
 * 输出期待 →（可选 extra）。整段是纯文本、无外部依赖，同一输入产出确定。
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const parts: string[] = [
    IDENTITY_SECTION,
    SEARCH_FIRST_SECTION,
    buildToolsSection(options.tools),
    OUTPUT_SECTION,
  ];
  if (options.extra !== undefined && options.extra.length > 0) {
    parts.push(options.extra);
  }
  return parts.join('\n\n');
}

export default buildSystemPrompt;
