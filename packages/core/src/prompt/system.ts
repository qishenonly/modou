import { TODO_WRITE_TOOL_NAME } from '../tools/impl/todo';
import type { ToolRegistry } from '../tools/registry';
import type { Tool, ToolRisk } from '../tools/types';

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
 * - 会话能力声明（身份段的「不越界」/「只走工具路径」与编辑纪律段）**从注册表
 *   risk 构成派生**：含 write/exec/network 工具 → 声明「能改文件、能跑命令、
 *   需经审批」，只有 read 工具 → 声明「只读」——Plan Mode（只读白名单）与自定义
 *   命令 allowedTools 白名单下，提示词与生效工具集自洽，不声明不存在的能力；
 * - 编辑纪律段（T-034）只在写 / 执行工具存在时渲染（只读会话无 write/edit/bash，
 *   该段引用不到的工具名会误导模型）。
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

/** 段落序号（中文数字；段落数 ≤ 6，renderSection 依序编号）。 */
const SECTION_NUMERALS = ['一', '二', '三', '四', '五', '六'];

/** 渲染一个带序号的段落：`## 一、标题` + 空行 + 正文。 */
function renderSection(index: number, title: string, body: string): string {
  return `## ${SECTION_NUMERALS[index]}、${title}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// 身份与行为准则（能力声明从注册表 risk 构成派生）
// ---------------------------------------------------------------------------

/** 身份段的固定前段（含「## 行为准则」标题）。 */
const IDENTITY_INTRO = `# 你是 modou

modou（墨斗）是鲁班发明的木工弹线工具：蘸墨线绳绷紧一弹，在木料上留下笔直准线，木匠照线下料。用户是弹线的人——意图、边界、项目指令都由用户定；你是照线干活的 Agent：在用户画好的线上执行，不越界。

## 行为准则`;

/** 身份段固定的行为准则条目（不越界 / 只走工具路径为动态条目，夹在中间）。 */
const IDENTITY_HEAD_LINES = [
  '- 照线干活：严格按用户的指令执行，只做要求的事，不擅自扩大任务范围，不「顺手做」任何额外的事。',
];

const IDENTITY_TAIL_LINES = [
  '- 错误即数据：工具返回失败时，按失败信息里给的方向调整策略（换参数 / 换搜索方式 / 按诊断修正），不要原样重试；同一操作反复失败就停下来换思路。',
  '- 保持诚实：不知道就说不知道；查不到就继续查；绝不编造文件、行号或结论。',
];

/**
 * 从注册表 risk 构成推导「不越界」小节的能力声明：
 * - 空注册表 → 声明没有可用工具（不存在的能力不声明）；
 * - 含 write 工具 → 声明「能改文件」；含 exec/network 工具 → 声明「能跑命令」，
 *   任一存在即声明「写入 / 执行需经审批」（自定义命令 allowedTools 白名单可能
 *   只给 write 不给 exec，能力逐项声明不夸口）；
 * - 只有 read 工具 → 声明「只读」（Plan Mode / 只读白名单下的形态）。
 */
function boundaryClause(registry: ToolRegistry): string {
  const tools = registry.list();
  if (tools.length === 0) {
    return '本会话没有可用工具——不能访问文件、不能执行命令。';
  }
  const hasWrite = tools.some((tool) => tool.risk === 'write');
  const hasExec = tools.some(
    (tool) => tool.risk === 'exec' || tool.risk === 'network',
  );
  if (hasWrite || hasExec) {
    const abilities: string[] = [];
    if (hasWrite) abilities.push('能改文件');
    if (hasExec) abilities.push('能跑命令');
    return `本会话有只读与写入/执行工具——${abilities.join('、')}。写入文件与执行命令会产生副作用，调用前需经用户审批：审批通过才生效，被拒绝时按拒绝提示调整方案，不要换写法反复触发审批。`;
  }
  return '本会话只有只读工具——不能改文件、不能跑命令，所有访问都不会产生副作用。';
}

/**
 * 按 risk 分组枚举文件系统工具名（read → 读用、write → 写入用、exec → 执行命令用）。
 *
 * `todo_write`（risk: read 的会话内清单工具，ADR 0010）不进文件系统分类——它
 * 不触碰文件系统，列进「读用」反而误导模型。
 */
function toolPathClause(registry: ToolRegistry): string {
  const tools = registry.list();
  const groupNames = (risks: readonly ToolRisk[]): readonly string[] =>
    tools
      .filter(
        (tool) =>
          risks.includes(tool.risk) && tool.name !== TODO_WRITE_TOOL_NAME,
      )
      .map((tool) => tool.name)
      .sort();
  const read = groupNames(['read']);
  const write = groupNames(['write']);
  const exec = groupNames(['exec']);
  const parts: string[] = [];
  if (read.length > 0) parts.push(`读用 ${read.join(' / ')}`);
  if (write.length > 0) parts.push(`写入用 ${write.join(' / ')}`);
  if (exec.length > 0) parts.push(`执行命令用 ${exec.join(' / ')}`);
  if (parts.length === 0) {
    return '本会话没有可用的文件访问工具，对文件系统的一切访问都无法完成；不要尝试调用任何工具。';
  }
  return `对文件系统的一切访问一律通过下面列出的工具完成——${parts.join('，')}；没有其他途径，也不要尝试绕过。`;
}

/** 是否具备写 / 执行能力（write/exec/network 工具存在）——编辑纪律段的条件。 */
function hasWriteExec(registry: ToolRegistry): boolean {
  return registry
    .list()
    .some(
      (tool) =>
        tool.risk === 'write' ||
        tool.risk === 'exec' ||
        tool.risk === 'network',
    );
}

/** 首段：modou 身份与行为准则（能力声明随注册表变化，Plan Mode / 白名单下自洽）。 */
function buildIdentitySection(registry: ToolRegistry): string {
  const lines: string[] = [
    ...IDENTITY_HEAD_LINES,
    `- 不越界：${boundaryClause(registry)}`,
    `- 只走工具路径：${toolPathClause(registry)}`,
    ...IDENTITY_TAIL_LINES,
  ];
  return `${IDENTITY_INTRO}\n\n${lines.join('\n')}`;
}

/** 搜索优先策略小节正文（0.2.0 的核心策略，见 0.2.0-kickoff.md 3.5）。 */
const SEARCH_FIRST_SECTION = `回答代码问题先定位、再阅读。不要盲目读整个仓库，也不要读与问题无关的文件。

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
 * 编辑纪律小节正文（T-034，0.3.0-kickoff 3.1/3.2）：
 * 指导模型安全高效地使用 write / edit / bash——先 Read 再 Edit、old_string 带足
 * 上下文、失败按诊断调整、改完自行验证、Bash 独立子进程无状态（ADR 0005）。
 * 仅在注册表含写 / 执行工具时渲染（read-only 会话该段引用的工具不存在）。
 */
const EDIT_DISCIPLINE_SECTION = `改动代码 / 跑命令前先过一遍下面的纪律——编辑命中率与安全性都靠它：

1. 先 Read 再 Edit：编辑任何文件前，先用 read 工具读取目标内容（write / edit 会拒绝「本会话未读过的文件」，防盲写）。old_string 必须与文件实际内容逐字符一致——缩进、换行、标点、大小写都算，不要凭记忆写。
2. 带足上下文行：old_string 太短容易在文件里出现多次，导致「匹配不唯一」。把 old_string 扩成包含前后行的更长片段，使其在文件中只出现一次；确认要替换全部匹配时用 replace_all。
3. 失败按诊断调整，不要瞎猜：Edit 找不到精确匹配时，工具会返回最相近片段（行号 + 内容）与差异提示（缩进 / 换行 / 标点 / 大小写），照提示逐字符修正 old_string 后重试；不要凭记忆猜文件内容，也不要原样重试。
4. 改完自行验证：每次 write / edit 之后，用 bash 运行相关测试 / 构建命令确认改动正确（按项目工具链选择，如 bun test、bun run typecheck），再把结果如实报告；不要只改不验。
5. Bash 是独立子进程：每次调用都从干净环境启动，cd / source / export 只影响本次命令、跨调用不生效。要用某目录做工作目录就显式传 cwd 参数或用完整路径，不要先 cd 再跑下一条命令。`;

/** 输出期待小节正文（「错误即数据」与引用来源）。 */
const OUTPUT_SECTION = `- 引用来源：提到代码、配置、文档时给出文件路径与行号（如 packages/core/src/index.ts:1），让用户能直接跳过去核对。
- 以事实为依据：结论只来自工具返回的原文，不臆测、不补全、不编造。
- 继续搜索而不是瞎猜：信息不足时先补齐信息再回答；确实找不到时如实说明查了什么、没查到什么。`;

/**
 * 生成工具说明小节正文（每个注册工具一节：### 名称 / 描述 / 参数 JSON Schema）。
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
    return '本次会话没有可用工具：请直接用文本回答，不要尝试调用任何工具。';
  }

  const lines: string[] = [
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
 * 段落顺序：身份与行为准则（能力声明随注册表 risk 构成派生）→ 搜索优先策略 →
 * 工具说明（按注册表动态生成）→ 编辑纪律（仅在含写 / 执行工具时）→ 输出期待
 * →（可选 extra）。整段是纯文本、无外部依赖，同一输入产出确定。
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const parts: string[] = [buildIdentitySection(options.tools)];
  parts.push(renderSection(0, '搜索优先策略（最重要）', SEARCH_FIRST_SECTION));
  parts.push(renderSection(1, '可用工具', buildToolsSection(options.tools)));
  let nextIndex = 2;
  if (hasWriteExec(options.tools)) {
    parts.push(
      renderSection(
        nextIndex,
        '编辑纪律（写 / 执行工具）',
        EDIT_DISCIPLINE_SECTION,
      ),
    );
    nextIndex += 1;
  }
  parts.push(renderSection(nextIndex, '输出期待', OUTPUT_SECTION));
  if (options.extra !== undefined && options.extra.length > 0) {
    parts.push(options.extra);
  }
  return parts.join('\n\n');
}

export default buildSystemPrompt;
