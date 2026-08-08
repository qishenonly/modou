import { z } from 'zod';
import type { SubagentResult } from '../types';
import type { Tool, ToolContext, ToolOutcome } from '../types';

/**
 * Task 工具（T-120）：派生子代理执行独立任务（supervisor 模式一层深，ADR 0011）。
 *
 * 主代理把「搜索 / 调研这类喧闹工作」交给子代理做，**只把最终结论文本拿回
 * 主上下文**——子代理有独立的消息历史与独立上下文窗口，它的内部过程不污染
 * 主上下文（G-0.12.0 的验收：主上下文 token 消耗显著低于不用子代理）。
 *
 * 执行路径：本工具 execute 经 `ctx.runSubagent`（运行时注入的派发通道）调起
 * 一次独立的 `runAgentTurn`，派发细节（注册表派生 / 系统提示词 / 一层深限制 /
 * 预算核算）都在 runtime/subagent.ts——tools 边界内不 import runtime，只持
 * 契约类型（SubagentRunner）。
 *
 * 边界（ADR 0011，全部在运行时代码层强制）：
 * - **一层深**：子代理不能再派生子代理（`subagentDepth ≥ 1` 时派发直接拒绝；
 *   同时本工具永不进入子代理注册表——白名单过滤时剔除）；
 * - **默认只读**：request 未传 tools 白名单时，子代理只有 read / grep / glob
 *   （只读三件套）；白名单是父代理工具集的子集，父代理没有的工具名静默跳过；
 * - **独立预算**：request 可传 maxTurns / maxTokens / timeoutMs（子代理独立
 *   核算，父代理预算不向下传导）；失败（超预算 / 超时 / 错误 / 中断）归一为
 *   ok:false 回喂主代理自纠（错误即数据，002 5.3）。
 *
 * 风险分类：**`read`**。本工具自身不触碰文件系统——子代理内部有副作用的工具
 * 调用（write / edit / bash）各自经审批闸门（与主代理共用），由 Permission 在
 * 执行点上裁决；`task` 本身不产生文件副作用，不额外触发审批。
 */

/** Task 工具名（单一来源：注册 / 系统提示词 / 白名单过滤复用）。 */
export const TASK_TOOL_NAME = 'task';

/** 白名单长度上限：单次派发最多列出的工具数（防止病态超大列表）。 */
export const TASK_TOOLS_MAX = 20;

/** Task 工具参数 schema（zod）：prompt 必填；description/tools/maxTurns/maxTokens 可选。 */
export const taskSchema = z.object({
  /** 简短任务描述（给人看 / 日志用；缺省取 prompt 首行）。 */
  description: z
    .string()
    .min(1, 'description 不能为空字符串')
    .max(500, 'description 最长 500 字符')
    .optional(),
  /** 交给子代理的完整指令（作为子代理对话的首条 user 消息）。 */
  prompt: z
    .string()
    .min(1, 'prompt 不能为空字符串')
    .max(8000, 'prompt 最长 8000 字符，请拆分成更聚焦的任务'),
  /** 工具白名单（父代理工具名的子集；缺省 = 只读三件套 read/grep/glob）。 */
  tools: z
    .array(z.string().min(1, '工具名不能为空字符串'))
    .max(TASK_TOOLS_MAX, `白名单最多 ${TASK_TOOLS_MAX} 个工具`)
    .optional(),
  /** 子代理轮次上限（独立预算；缺省 10）。 */
  maxTurns: z
    .number()
    .int('maxTurns 必须是整数')
    .positive('maxTurns 必须是正整数')
    .optional(),
  /** 子代理 token 预算（独立核算；缺省不限）。 */
  maxTokens: z
    .number()
    .int('maxTokens 必须是整数')
    .positive('maxTokens 必须是正整数')
    .optional(),
  /** 子代理墙钟超时（毫秒；缺省不限——靠 maxTurns/maxTokens 兜底）。 */
  timeoutMs: z
    .number()
    .int('timeoutMs 必须是整数')
    .positive('timeoutMs 必须是正整数')
    .optional(),
});

export type TaskArgs = z.infer<typeof taskSchema>;

/** 把子代理结果归一为 ToolOutcome（错误即数据：失败也回喂可诊断文本）。 */
function toOutcome(args: TaskArgs, result: SubagentResult): ToolOutcome {
  const label = args.description ?? args.prompt.split('\n')[0];
  const forModel = result.ok
    ? `子代理任务「${label}」完成（${result.turns ?? '?'} 轮）：\n\n${result.text}`
    : `子代理任务「${label}」失败：${result.error ?? '未知原因'}\n` +
      `已产出文本：${result.text || '（无）'}\n` +
      `按失败原因调整策略后重试，或把任务拆得更小后再派发。`;
  return {
    ok: result.ok,
    forModel,
    summary: result.ok
      ? `子代理完成（${result.turns ?? '?'} 轮，${label}）`
      : `子代理失败：${result.error ?? '未知原因'}`,
    payload: {
      ok: result.ok,
      agentId: result.agentId,
      description: label,
      text: result.text,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.turns !== undefined ? { turns: result.turns } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    },
  };
}

/** 构造 Task 工具。无依赖注入选项（子代理派发通道由运行时经 ToolContext 注入）。 */
export function createTaskTool(): Tool<typeof taskSchema> {
  return {
    name: TASK_TOOL_NAME,
    description:
      '派生子代理执行独立任务（supervisor 一层深）。适合搜索、调研这类喧闹工作：' +
      '子代理有独立的消息历史与上下文窗口，只把最终结论文本返回给主代理——' +
      '主上下文不被子代理的中间过程污染。参数：prompt 必填（交给子代理的完整指令）；' +
      'description 可选（简短任务描述）；tools 可选（子代理工具白名单，父代理工具名的子集，' +
      '缺省只读三件套 read/grep/glob——默认只读，需要写入时由主代理执行）；' +
      'maxTurns 可选（子代理轮次上限，默认 10）；maxTokens 可选（子代理 token 预算）；' +
      'timeoutMs 可选（子代理墙钟超时毫秒）。子代理不能再派生子代理（一层深限制）。' +
      '返回子代理的最终结论；失败时返回可诊断原因，请据此调整策略后重试。',
    schema: taskSchema,
    // 见文件头注释：本工具自身不触碰文件系统，子代理内部有副作用的工具各自
    // 经审批闸门裁决，task 不额外触发审批（与 todo_write 同类的「无文件副作用」）。
    risk: 'read',
    execute: async (args: TaskArgs, ctx: ToolContext): Promise<ToolOutcome> => {
      if (ctx.runSubagent === undefined) {
        return {
          ok: false,
          forModel:
            'Task 工具不可用：当前运行环境未注入子代理派发通道（runSubagent）。' +
            '子代理只在完整 Agent 循环内可用，请用主代理直接完成任务。',
        };
      }
      const result = await ctx.runSubagent({
        prompt: args.prompt,
        ...(args.tools !== undefined ? { tools: args.tools } : {}),
        ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
        ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      });
      return toOutcome(args, result);
    },
  };
}

/** 默认 Task 工具实例（0.12.0 子代理工具）。 */
export const taskTool: Tool<typeof taskSchema> = createTaskTool();
