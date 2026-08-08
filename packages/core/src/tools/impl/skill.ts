import { z } from 'zod';
import type { Tool, ToolOutcome } from '../types';

/**
 * Skill 工具（0.15.0 T-152 渐进式披露）：按名加载技能正文 + 附带文件清单注入上下文。
 *
 * 设计依据（0.15.0-kickoff 3.1 / ADR 0014）：
 * - **触发判断由模型做**：所有技能的 name + description 作为清单常驻系统提示词
 *   （buildSystemPrompt 的 skills 选项渲染），模型自己判断当前任务是否命中某技能，
 *   命中时才调用本工具拉取正文——非关键词匹配，触发逻辑随模型能力提升，不需维护规则；
 * - 正文只在工具结果里注入：本工具返回的 forModel 文本进入对话线程，模型按正文执行；
 *   未触发的技能对上下文的占用仅为其描述行（渐进式披露）；
 * - 附带文件（scripts/ 等）以相对路径清单一并告知模型（技能正文会引用它们）；
 * - allowed-tools（标准字段）注入时以声明形式告知模型「本技能在哪些工具范围内操作」；
 * - **未知技能错误即数据**：resolve 未命中返回 ok:false 并列出可用技能名，让模型
 *   自纠（核对清单名称，严格匹配），而不是抛异常。
 *
 * 边界：本工具只读（risk: read，不产生副作用）；resolve 由装配方注入
 * （TUI 用 discoverSkills 结果建索引），与技能发现模块结构解耦——SkillInfo 是
 * 结构接口，DiscoverdSkill 结构上满足它。
 */

/** Skill 工具名（注册名：skill）。 */
export const SKILL_TOOL_NAME = 'skill';

/** Skill 工具参数 schema：技能名（与清单一致，严格匹配）。 */
export const skillSchema = z.object({
  name: z.string().min(1, 'name 不能为空字符串'),
});

export type SkillArgs = z.infer<typeof skillSchema>;

/** 一次技能加载所需的信息（DiscoverdSkill 结构上满足本接口）。 */
export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  /** 正文（frontmatter 之后），命中时整体注入。 */
  readonly body: string;
  /** 技能目录（注入时给出出处，模型可据此定位附带文件）。 */
  readonly directory?: string;
  /** 附带文件清单（相对技能目录，不含 SKILL.md）。 */
  readonly files?: readonly string[];
  /** 技能声明的工具白名单（allowed-tools；注入时告知模型操作范围）。 */
  readonly allowedTools?: readonly string[];
}

/** 技能解析器：装配方注入（TUI 用 discoverSkills 的索引实现）。 */
export type SkillResolver = (name: string) => SkillInfo | undefined;

/** createSkillTool 入参。 */
export interface SkillToolDeps {
  readonly resolve: SkillResolver;
  /** 可用技能名（未知技能错误里列出，供模型核对；缺省空）。 */
  readonly names?: () => readonly string[];
}

/** 未知技能 / 无技能的失败结果（错误即数据，列出可用项供模型自纠）。 */
function unknownSkillOutcome(name: string, deps: SkillToolDeps): ToolOutcome {
  const available = deps.names !== undefined ? deps.names() : [];
  const listText =
    available.length > 0
      ? `可用技能：${available.join('、')}。`
      : '当前没有可用技能。';
  return {
    ok: false,
    forModel:
      `未知技能 "${name}"：${listText}技能名与清单严格匹配（注意大小写与连字符），` +
      `请先核对系统提示词里的技能清单再调用，不要臆造技能名。`,
  };
}

/**
 * 渲染一次技能加载的注入文本：标题（技能名 + 说明 + 来源目录）→ 正文 →
 * 附带文件清单（正文里会引用它们）。allowed-tools 声明操作范围。
 */
function renderSkillInjection(info: SkillInfo): string {
  const lines: string[] = [];
  lines.push(`# 技能：${info.name}`);
  if (info.description.length > 0) {
    lines.push(`说明：${info.description}`);
  }
  if (info.directory !== undefined && info.directory.length > 0) {
    lines.push(`来源目录：${info.directory}`);
  }
  const tools = info.allowedTools ?? [];
  if (tools.length > 0) {
    lines.push(
      `本技能声明可用的工具：${tools.join('、')}——加载本技能后请只在声明的工具范围内操作。`,
    );
  }
  lines.push('');
  lines.push(info.body);
  const files = info.files ?? [];
  if (files.length > 0) {
    lines.push(
      '',
      '本技能的附带文件（路径相对技能目录，正文里引用它们时据此定位）：',
      ...files.map((file) => `- ${file}`),
    );
  }
  return lines.join('\n');
}

/** 构造 Skill 工具（deps 注入解析器与可用名单；测试可注入 stub）。 */
export function createSkillTool(deps: SkillToolDeps): Tool<typeof skillSchema> {
  return {
    name: SKILL_TOOL_NAME,
    description:
      '加载技能正文：技能是特定任务才适用的分步流程知识（代码审查、写测试、' +
      '写 commit message、调试排查等），先根据系统提示词里的技能清单判断当前任务' +
      '是否命中某技能，命中时用本工具加载其正文与附带文件清单，再按正文执行；' +
      '技能正文只在本工具返回时注入，不常驻上下文。' +
      'name 传技能名（与清单严格一致，注意大小写与连字符）。',
    schema: skillSchema,
    risk: 'read',
    execute: async (args: SkillArgs): Promise<ToolOutcome> =>
      executeSkill(args, deps),
  };
}

/** 执行一次技能加载（由 createSkillTool 闭包注入 deps）。 */
async function executeSkill(
  args: SkillArgs,
  deps: SkillToolDeps,
): Promise<ToolOutcome> {
  const info = deps.resolve(args.name);
  if (info === undefined) {
    return unknownSkillOutcome(args.name, deps);
  }
  const forModel = renderSkillInjection(info);
  const fileCount = (info.files ?? []).length;
  return {
    ok: true,
    forModel,
    summary: `技能 ${info.name}：正文已注入${fileCount > 0 ? `（含 ${fileCount} 个附带文件）` : ''}`,
  };
}

/** 默认 Skill 工具实例：未注入解析器——调用即「没有可用技能」失败（供注册表占位）。 */
export const skillTool: Tool<typeof skillSchema> = createSkillTool({
  resolve: () => undefined,
  names: () => [],
});
