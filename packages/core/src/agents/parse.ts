import { parseCommandFrontmatter } from '../config/commands';

/**
 * 自定义 agents 解析（0.17.0 T-170，design 002 十节扩展点表：
 * 自定义 agents = Config 加载 `.modou/agents/*.md`，复用 0.12.0 子代理运行时）。
 *
 * `.modou/agents/*.md` 即角色：frontmatter 声明元信息（name / description /
 * allowedTools / model），正文 = 角色提示词（作为子代理系统提示词的追加段）。
 * 文件格式与 `.modou/commands/*.md` 完全同形（YAML 风格 frontmatter 夹在首尾
 * `---` 之间）——自定义 agent 是自定义命令的「角色化」形态：命令是一次性注入的
 * 提示词，agent 是常驻的角色配置（独立 prompt + 工具白名单 + 模型指定），
 * 经子代理运行时派发（独立消息历史 / 独立上下文窗口）。
 *
 * 字段语义：
 * - `name`：角色名（agent 工具按名派发），必须、唯一；
 * - `description`：系统提示词角色清单展示用（必须）；
 * - `allowedTools`：可选，逗号分隔的工具名白名单——派发时注册表只含这些工具，
 *   白名单外的调用在 ① Resolve 即被拒（「未知工具」），**真正强制**而非声明；
 *   未声明 = 继承父代理完整工具集（与自定义命令的语义一致）；
 * - `model`：可选，默认模型（派发时按此重建 provider 实例，002 8.2）；
 * - 正文：角色提示词，拼在子代理系统提示词末尾（与项目指令同定位：用户手写的
 *   对模型的行为要求）。
 *
 * 依赖方向：agents 属于 Config 扩展点，复用 config/commands 的 frontmatter
 * 解析（同形格式不重复实现），只依赖 node 内建与本模块；不 import runtime /
 * provider（002 2.2 Config 扩展点约束，与 skills 模块同级）。
 */

/** 一个自定义 agent（从 `.modou/agents/*.md` 解析所得）。 */
export interface CustomAgent {
  /** 角色名（agent 工具按名派发；与清单严格匹配）。 */
  readonly name: string;
  /** 一句话描述（系统提示词角色清单展示）。 */
  readonly description: string;
  /** 角色提示词（frontmatter 之后的正文；派发时拼入子代理系统提示词）。 */
  readonly systemPrompt: string;
  /** 工具白名单（未声明 = 空数组 = 继承父代理完整工具集）。 */
  readonly allowedTools: readonly string[];
  /** 默认模型（未声明 = 沿用父代理当前模型）。 */
  readonly model?: string;
  /** 来源文件绝对路径（错误 / 审计用）。 */
  readonly file: string;
}

/**
 * 解析一份 `.modou/agents/*.md` 文件内容为 CustomAgent。
 * 无 frontmatter / 缺 name / description / 正文时返回 null（调用方跳过并记录）。
 * frontmatter 解析与自定义命令同一实现（parseCommandFrontmatter）——同形格式，
 * 不重复实现解析器。
 */
export function parseAgentMarkdown(
  text: string,
  file: string,
): CustomAgent | null {
  const parsed = parseCommandFrontmatter(text);
  if (parsed === null) return null;
  return {
    name: parsed.name,
    description: parsed.description,
    systemPrompt: parsed.prompt,
    allowedTools: parsed.allowedTools ?? [],
    ...(parsed.model !== undefined && parsed.model.length > 0
      ? { model: parsed.model }
      : {}),
    file,
  };
}

/** 进系统提示词角色清单的摘要（只含 name + description，供模型判断何时派发）。 */
export interface AgentSummary {
  readonly name: string;
  readonly description: string;
}
