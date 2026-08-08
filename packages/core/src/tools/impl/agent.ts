import { z } from 'zod';
import type { Tool, ToolContext, ToolOutcome } from '../types';

/**
 * agent 工具（0.17.0 T-170）：按名派发自定义 agent（角色化子代理）。
 *
 * 自定义 agent = 子代理 + 角色配置（复用 0.12.0 子代理运行时，ADR 0011）：
 * 派发一次 = 用**按角色白名单派生的注册表** + **含角色提示词的系统提示词** +
 * **request.prompt 首条 user 消息**再跑一次 `runAgentTurn`——独立的消息历史、
 * 独立的上下文窗口、独立的预算核算。父代理只拿到 SubagentResult（最终结论），
 * 角色派发的内部过程不污染主上下文。
 *
 * 角色解析（deps.resolve 按名查 `.modou/agents/*.md` 加载的角色）由装配方注入
 * （TUI 用 discoverAgents 结果建索引），与 Skill 工具的 resolver 同一模式——
 * 本工具不感知 agents 发现模块，只持结构接口（AgentInfo 是结构接口，DiscoverdAgent
 * 结构上满足它；tools 边界只依赖 zod 与 protocol/events，不 import Config 扩展点）。
 *
 * 边界（全部在运行时代码层强制）：
 * - **白名单真正强制**：角色派发的注册表只含 allowedTools 内的工具（未声明 =
 *   继承父代理完整工具集）；白名单外的调用在 ① Resolve 即被拒（「未知工具」）——
 *   越界拒绝（G-0.17.0 验收门），不是声明而是结构。
 * - **一层深**：角色派发不能再派生子代理（subagentDepth ≥ 1 时派发直接拒绝；
 *   task 工具也永不进入角色注册表——deriveAgentRegistry 过滤，双保险）。
 * - **模型指定**：角色声明 model 时经装配方注入的 resolveModel 重建 provider。
 *
 * 风险分类：**`read`**。本工具自身不触碰文件系统——角色派发内部有副作用的工具
 * 调用（write / edit / bash / webfetch）各自经审批闸门（与主代理共用），由
 * Permission 在执行点上裁决；`agent` 本身不产生副作用，不额外触发审批
 * （与 task 工具同类——task 也是 risk: read）。
 */

/** agent 工具名（注册名：agent）。 */
export const AGENT_TOOL_NAME = 'agent';

/** agent 工具参数 schema：角色名 + 任务指令。 */
export const agentSchema = z.object({
  /** 角色名（与系统提示词角色清单严格匹配，注意大小写与连字符）。 */
  name: z.string().min(1, 'name 不能为空字符串'),
  /** 交给角色的任务指令（作为角色派发对话的首条 user 消息）。 */
  prompt: z
    .string()
    .min(1, 'prompt 不能为空字符串')
    .max(8000, 'prompt 最长 8000 字符，请拆分成更聚焦的任务'),
});

export type AgentArgs = z.infer<typeof agentSchema>;

/** 一次角色派发所需的角色信息（CustomAgent / DiscoveredAgent 结构上满足本接口）。 */
export interface AgentInfo {
  readonly name: string;
  /** 角色提示词（拼入子代理系统提示词的追加段）。 */
  readonly systemPrompt: string;
  /** 工具白名单（未声明 = 空数组 = 继承父代理完整工具集）。 */
  readonly allowedTools: readonly string[];
  /** 角色指定模型（缺省 = 沿用父代理当前模型）。 */
  readonly model?: string;
}

/** 角色解析器：装配方注入（TUI 用 discoverAgents 结果建索引）。 */
export type AgentResolver = (name: string) => AgentInfo | undefined;

/** createAgentTool 入参。 */
export interface AgentToolDeps {
  readonly resolve: AgentResolver;
  /** 可用角色名（未知角色错误里列出，供模型核对；缺省空）。 */
  readonly names?: () => readonly string[];
}

/** 未知角色 / 无角色的失败结果（错误即数据，列出可用项供模型自纠）。 */
function unknownAgentOutcome(name: string, deps: AgentToolDeps): ToolOutcome {
  const available = deps.names !== undefined ? deps.names() : [];
  const listText =
    available.length > 0
      ? `可用角色：${available.join('、')}。`
      : '当前没有可用角色。';
  return {
    ok: false,
    forModel:
      `未知角色 "${name}"：${listText}角色名与系统提示词里的清单严格匹配` +
      `（注意大小写与连字符），请先核对清单再调用，不要臆造角色名。`,
  };
}

/** 把角色派发结果归一为 ToolOutcome（错误即数据：失败也回喂可诊断文本）。 */
function toOutcome(
  agent: AgentInfo,
  result: { ok: boolean; text: string; error?: string; turns?: number },
): ToolOutcome {
  const forModel = result.ok
    ? `自定义 agent「${agent.name}」完成（${result.turns ?? '?'} 轮）：\n\n${result.text}`
    : `自定义 agent「${agent.name}」失败：${result.error ?? '未知原因'}\n` +
      `已产出文本：${result.text || '（无）'}\n` +
      `按失败原因调整策略后重试，或改用主代理直接完成。`;
  return {
    ok: result.ok,
    forModel,
    summary: result.ok
      ? `角色 ${agent.name} 完成（${result.turns ?? '?'} 轮）`
      : `角色 ${agent.name} 失败：${result.error ?? '未知原因'}`,
    payload: {
      ok: result.ok,
      agent: agent.name,
      text: result.text,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.turns !== undefined ? { turns: result.turns } : {}),
    },
  };
}

/** 构造 agent 工具（deps 注入角色解析器与可用名单；测试可注入 stub）。 */
export function createAgentTool(deps: AgentToolDeps): Tool<typeof agentSchema> {
  return {
    name: AGENT_TOOL_NAME,
    description:
      '派发自定义 agent（角色化子代理）执行独立任务。自定义 agent 是项目在 ' +
      '.modou/agents/*.md 里定义的角色——有独立的系统提示词（角色提示词）、' +
      '工具白名单（allowedTools）与可选模型（model）。适合需要特定专家视角的' +
      '任务（代码审查、调试、调研等）：角色派发有独立的消息历史与上下文窗口，' +
      '只把最终结论文本返回给主代理——主上下文不被其内部过程污染。' +
      '参数：name 必填（角色名，与系统提示词里的角色清单严格一致）；' +
      'prompt 必填（交给角色的完整任务指令）。角色不能再次派发角色或子代理（一层深限制）。' +
      '返回角色的最终结论；失败时返回可诊断原因，请据此调整策略后重试。',
    schema: agentSchema,
    // 见文件头注释：本工具自身不产生副作用（角色派发内部有副作用的工具各自
    // 经审批闸门裁决），与 task 工具同类，不额外触发审批。
    risk: 'read',
    // 同一轮多次派发时并行执行（与 task 工具同款）：角色派发默认继承父代理
    // 工具集或白名单子集，角色之间的共享状态由写冲突检测兜底（ADR 0011），
    // 并行安全；结果按调用顺序聚合。
    concurrent: true,
    execute: async (
      args: AgentArgs,
      ctx: ToolContext,
    ): Promise<ToolOutcome> => {
      const agent = deps.resolve(args.name);
      if (agent === undefined) {
        return unknownAgentOutcome(args.name, deps);
      }
      if (ctx.runAgent === undefined) {
        return {
          ok: false,
          forModel:
            'agent 工具不可用：当前运行环境未注入自定义 agent 派发通道（runAgent）。' +
            '自定义 agent 只在完整 Agent 循环内可用，请用主代理直接完成任务。',
        };
      }
      const result = await ctx.runAgent({
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        allowedTools: agent.allowedTools,
        ...(agent.model !== undefined ? { model: agent.model } : {}),
        prompt: args.prompt,
      });
      return toOutcome(agent, result);
    },
  };
}

/** 默认 agent 工具实例：未注入解析器——调用即「没有可用角色」失败（供注册表占位）。 */
export const agentTool: Tool<typeof agentSchema> = createAgentTool({
  resolve: () => undefined,
  names: () => [],
});
