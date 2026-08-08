import { randomUUID } from 'node:crypto';
import type { ApprovalGate } from '../permission/approval';
import { buildSystemPrompt } from '../prompt/system';
import type { ModelProvider } from '../provider/types';
import { AGENT_TOOL_NAME } from '../tools/impl/agent';
import { TASK_TOOL_NAME } from '../tools/impl/task';
import { ToolRegistry } from '../tools/registry';
import {
  SUBAGENT_DEFAULT_MAX_TURNS,
  type AgentDispatchRequest,
  type AgentRunner,
  type SubagentResult,
  type WriteConflictReport,
} from '../tools/types';
import { combineSignals, toResult } from './subagent';
import { SUBAGENT_DEPTH_LIMIT } from './subagent';
import type { RunAgentTurnInput, RuntimeEvent, TurnResult } from './loop';

/**
 * 自定义 agent 派发器（0.17.0 T-170，design 002 十节扩展点表：
 * 自定义 agents = 子代理 + 角色配置，复用 0.12.0 子代理运行时）。
 *
 * 与子代理派发（runtime/subagent.ts）共用同一内核：一次 `runAgentTurn` 的独立
 * 消息历史 / 独立上下文窗口 / 独立预算。差异点（自定义 agent 的「角色化」）：
 *
 * 1. **角色提示词**：agent 的 systemPrompt 作为 buildSystemPrompt 的 extra 段拼入
 *    子代理系统提示词（与项目指令同定位——用户手写的对模型的行为要求）；
 * 2. **白名单派生**：注册表按角色 allowedTools 从父代理注册表派生——**真正强制**：
 *    白名单外的工具根本不在注册表里，模型调用在管线 ① Resolve 即被拒（「未知
 *    工具」）；未声明白名单 = 继承父代理完整工具集（与自定义命令的语义一致）；
 * 3. **模型指定**：agent 声明 model 时经 resolveModel（调用方注入，TUI 按
 *    装配面重建 provider）换 provider 实例；未声明 = 沿用父代理当前 provider；
 * 4. 其余边界与子代理相同：一层深（task 工具剔除）、权限继承不超父、写冲突
 *    检测、钩子总线继承、事件流按 agentId 转出。
 *
 * 模块依赖：subagent.ts 导出派发辅助（toResult / combineSignals / 深度上限），
 * 本模块只做「角色化」的增量，不复制子代理派发逻辑。
 */

/** 角色化派发器的构造选项（主代理 loop 装配后传入；复用子代理派发器的装配面）。 */
export interface AgentRunnerOptions {
  /** 实际的 turn 内核（= runAgentTurn）。注入而非直接 import（同 subagent.ts）。 */
  readonly runTurn: (
    input: RunAgentTurnInput,
    onEvent?: (event: RuntimeEvent) => void,
  ) => Promise<TurnResult>;
  /** 父代理的供应商（角色未指定模型时的回落）。 */
  readonly provider: ModelProvider;
  /** 父代理的工具注册表（角色白名单从它派生）。缺省 = 无工具。 */
  readonly parentRegistry: ToolRegistry | undefined;
  /** 会话级已读文件集合（共享同一 Set：角色派发后的 Read 主代理可见可写）。 */
  readonly readFiles: Set<string>;
  /** 工作目录（沿用父代理的 cwd）。 */
  readonly cwd: string;
  /** 审批闸门（与父代理共用同一实例——权限继承，allow_always 记忆继承）。 */
  readonly approval?: ApprovalGate;
  /** 主代理的中断信号（透传给角色派发：主代理被打断时角色同步停）。 */
  readonly abortSignal?: AbortSignal;
  /** 当前 loop 的深度：0 = 主代理，≥ SUBAGENT_DEPTH_LIMIT = 子代理。 */
  readonly depth: number;
  /** 事件转发出口（T-122 同款：角色派发的事件包上 agentId 转出为 subagent_event）。 */
  readonly emit?: (event: RuntimeEvent) => void;
  /** 写冲突检测钩子（透传主代理的 onFileWrite，按自身 agentId 上报）。 */
  readonly onFileWrite?: (
    path: string,
    agent: string,
  ) => WriteConflictReport | undefined;
  /** 钩子总线（角色派发的工具调用同样过 ④⑦ 钩子——统一管线安全面）。 */
  readonly hooks?: import('../hooks/bus').HookBus;
  /**
   * 模型解析工厂：角色声明 model 时按模型 ID 重建 provider 实例（002 8.2
   * 换 provider 实例）。由装配方注入（TUI 按 providerSpec + 环境变量重建）。
   * 缺省 = 不切换（角色 model 被忽略，沿用父代理 provider）——headless /
   * 测试注入 stub 覆盖离线行为。返回 undefined = 无法解析该模型（派发失败
   * 回喂可诊断错误，错误即数据）。
   */
  readonly resolveModel?: (model: string) => ModelProvider | undefined;
}

/**
 * 从父代理注册表按角色白名单派生子代理注册表（白名单真正强制）：
 * - 白名单为空 = 继承父代理完整工具集（自定义 agent 未声明 allowedTools 的语义）；
 * - 白名单非空 = 只含白名单内且父代理存在的工具——白名单外的工具根本不在
 *   注册表里，模型调用在 ① Resolve 即被拒（越界拒绝，G-0.17.0 验收门）；
 * - 父代理没有的工具名静默跳过（权限继承不超父，ADR 0011）；
 * - task 工具与 agent 工具永不进入（一层深限制，ADR 0011 双保险；
 *   0.17.0 design-checker 偏离 4：agent 与 task 同为「派发型」工具，角色派发
 *   内部再派发角色 = 二层嵌套，同样禁止）。
 */
export function deriveAgentRegistry(
  parent: ToolRegistry | undefined,
  allowedTools: readonly string[] | undefined,
): ToolRegistry {
  const derived = new ToolRegistry();
  if (parent === undefined) return derived;
  const names =
    allowedTools !== undefined && allowedTools.length > 0
      ? allowedTools
      : parent.names();
  for (const name of names) {
    const tool = parent.find(name);
    if (tool === undefined) continue;
    if (tool.name === TASK_TOOL_NAME) continue;
    if (tool.name === AGENT_TOOL_NAME) continue;
    derived.register(tool);
  }
  return derived;
}

/**
 * 角色化子代理系统提示词：普通系统提示词 + 角色提示词追加段（extra）。
 * 与 buildSubagentSystemPrompt 的唯一差异 = extra 是角色的提示词而非通用子代理指令。
 */
export function buildAgentSystemPrompt(
  registry: ToolRegistry,
  request: AgentDispatchRequest,
): string {
  const extra = `## 角色：${request.name}\n\n${request.systemPrompt}`;
  return buildSystemPrompt({ tools: registry, extra });
}

/** 构造自定义 agent 派发函数（agent 工具经 ToolContext.runAgent 调用）。 */
export function createAgentRunner(options: AgentRunnerOptions): AgentRunner {
  return async (request: AgentDispatchRequest): Promise<SubagentResult> => {
    // —— 一层深硬限制（ADR 0011）：角色派发同样不能再派生子代理 ——
    if (options.depth >= SUBAGENT_DEPTH_LIMIT) {
      return {
        ok: false,
        text: '',
        error:
          '自定义 agent 不能再派生子代理（一层深限制，ADR 0011）：本次任务由主代理直接完成或改用普通子代理（task 工具）。',
      };
    }

    const registry = deriveAgentRegistry(
      options.parentRegistry,
      request.allowedTools,
    );
    const system = buildAgentSystemPrompt(registry, request);

    // —— 模型指定（002 8.2 换 provider 实例）：角色声明 model 时经 resolveModel
    // 重建 provider；解析失败 = 派发失败回喂可诊断错误（错误即数据）。——
    let provider = options.provider;
    if (request.model !== undefined) {
      if (options.resolveModel === undefined) {
        return {
          ok: false,
          text: '',
          error:
            `自定义 agent「${request.name}」指定了模型 ${request.model}，` +
            `但当前运行环境未装配模型解析（resolveModel）——无法切换模型，` +
            `请改用当前模型直接完成，或在装配侧注入模型解析后重试。`,
        };
      }
      const resolved = options.resolveModel(request.model);
      if (resolved === undefined) {
        return {
          ok: false,
          text: '',
          error:
            `自定义 agent「${request.name}」指定了模型 ${request.model}，` +
            `但该模型无法解析（resolveModel 返回空）——请核对模型 ID 或改用当前模型。`,
        };
      }
      provider = resolved;
    }

    const agentId = `agent-${request.name}-${randomUUID().slice(0, 4)}`;

    // —— 独立预算 / 独立消息历史 / 独立上下文窗口 ——
    // 只传 request.prompt 首条 user 消息（不携带父代理历史）；maxTurns 用
    // 子代理缺省值（角色派发本版不暴露 budget 参数，与 task 工具对齐）。
    let result: TurnResult;
    try {
      result = await options.runTurn(
        {
          provider,
          system,
          messages: [{ role: 'user', content: request.prompt }],
          ...(registry.size > 0 ? { tools: registry } : {}),
          readFiles: options.readFiles,
          cwd: options.cwd,
          approval: options.approval,
          options: {
            maxTurns: SUBAGENT_DEFAULT_MAX_TURNS,
            ...(options.abortSignal !== undefined
              ? { abortSignal: combineSignals([options.abortSignal]) }
              : {}),
          },
          subagentDepth: SUBAGENT_DEPTH_LIMIT,
          agentId,
          onFileWrite: (path) => options.onFileWrite?.(path, agentId),
          ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
        },
        (event) => {
          options.emit?.({ type: 'subagent_event', agent: agentId, event });
        },
      );
    } finally {
      // 与子代理派发的超时定时器语义对齐：本版角色派发不设默认墙钟超时，
      // 靠 maxTurns 预算兜底（与 task 工具缺省语义一致）。
    }

    // 共享 Set 语义兑现（0.12.1 修复同款）：角色派发内部 Read 过的文件并入父集合
    for (const path of result.readFiles) {
      options.readFiles.add(path);
    }

    return toResult(agentId, result);
  };
}
