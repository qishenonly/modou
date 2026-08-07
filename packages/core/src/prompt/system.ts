import type { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';

/**
 * 系统提示词模块（T-023/T-034）：面向模型的 Agent 系统提示词。
 *
 * 设计依据（docs/design/002-architecture.md 7.1、docs/plan/kickoff/0.3.0-kickoff.md 3.1/3.3）：
 * - 系统提示词位于上下文投影的「稳定前缀」（002 7.1），全会话只付一次缓存全价；
 *   工具定义有两条通道：原生 ToolSet 经 `toToolSet` 传给 provider（保证模型能
 *   发出 tool_use、可执行），这里同时以文本内嵌 JSON Schema（让模型读到用法要点
 *   与参数约束）——双通道冗余但有意为之，改动时需联动；
 * - 工具说明与注册表**单一来源**：每个工具的 name / description / JSON Schema
 *   （z.toJSONSchema，注册表缓存）直接取自 ToolRegistry。注册新工具即自动出现在
 *   提示词里，不会出现「提示词与工具定义失配」；
 * - 0.3.0 起会话具备写 / 执行工具（write / edit / bash，经 defaultWriteTools 装配，
 *   CLI 入口默认使用），行为准则相应更新为「写入与执行需经审批」；编辑纪律段
 *   （T-034）指导模型先 Read 再 Edit、带足上下文、失败按诊断调整、改完自行验证、
 *   Bash 独立子进程无状态。
 */

/** buildSystemPrompt 的选项。 */
export interface BuildSystemPromptOptions {
  /** 工具注册表：工具定义的单一来源（name / description / schema → JSON Schema）。 */
  readonly tools: ToolRegistry;
  /**
   * 可选追加段（拼在提示词末尾；T-081 起由 runTui 注入项目指令段——AGENTS.md
   * 三级指令「全局 → 项目根 → 子目录」的渲染结果，作为稳定前缀的一部分）。
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
- 不越界：本会话有只读与写入/执行工具（read / grep / glob / write / edit / bash）——能改文件、能跑命令。写入文件与执行命令会产生副作用，调用前需经用户审批：审批通过才生效，被拒绝时按拒绝提示调整方案，不要换写法反复触发审批。
- 只走工具路径：对文件系统的一切访问一律通过下面列出的工具完成——读用 read / grep / glob，写入用 write / edit，执行命令用 bash；没有其他途径，也不要尝试绕过。
- 错误即数据：工具返回失败时，按失败信息里给的方向调整策略（换参数 / 换搜索方式 / 按诊断修正），不要原样重试；同一操作反复失败就停下来换思路。
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

/**
 * 编辑纪律小节（T-034，0.3.0-kickoff 3.1/3.2）：
 * 指导模型安全高效地使用 write / edit / bash——先 Read 再 Edit、old_string 带足
 * 上下文、失败按诊断调整、改完自行验证、Bash 独立子进程无状态（ADR 0005）。
 */
const EDIT_DISCIPLINE_SECTION = `## 三、编辑纪律（写 / 执行工具）

改动代码 / 跑命令前先过一遍下面的纪律——编辑命中率与安全性都靠它：

1. 先 Read 再 Edit：编辑任何文件前，先用 read 工具读取目标内容（write / edit 会拒绝「本会话未读过的文件」，防盲写）。old_string 必须与文件实际内容逐字符一致——缩进、换行、标点、大小写都算，不要凭记忆写。
2. 带足上下文行：old_string 太短容易在文件里出现多次，导致「匹配不唯一」。把 old_string 扩成包含前后行的更长片段，使其在文件中只出现一次；确认要替换全部匹配时用 replace_all。
3. 失败按诊断调整，不要瞎猜：Edit 找不到精确匹配时，工具会返回最相近片段（行号 + 内容）与差异提示（缩进 / 换行 / 标点 / 大小写），照提示逐字符修正 old_string 后重试；不要凭记忆猜文件内容，也不要原样重试。
4. 改完自行验证：每次 write / edit 之后，用 bash 运行相关测试 / 构建命令确认改动正确（按项目工具链选择，如 bun test、bun run typecheck），再把结果如实报告；不要只改不验。
5. Bash 是独立子进程：每次调用都从干净环境启动，cd / source / export 只影响本次命令、跨调用不生效。要用某目录做工作目录就显式传 cwd 参数或用完整路径，不要先 cd 再跑下一条命令。`;

/** 输出期待小节（「错误即数据」与引用来源）。 */
const OUTPUT_SECTION = `## 四、输出期待

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
 * 构建系统提示词（T-023 / T-034）。
 *
 * 段落顺序：身份与行为准则 → 搜索优先策略 → 工具说明（按注册表动态生成）→
 * 编辑纪律 → 输出期待 →（可选 extra）。整段是纯文本、无外部依赖，同一输入产出确定。
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const parts: string[] = [
    IDENTITY_SECTION,
    SEARCH_FIRST_SECTION,
    buildToolsSection(options.tools),
    EDIT_DISCIPLINE_SECTION,
    OUTPUT_SECTION,
  ];
  if (options.extra !== undefined && options.extra.length > 0) {
    parts.push(options.extra);
  }
  return parts.join('\n\n');
}

export default buildSystemPrompt;
