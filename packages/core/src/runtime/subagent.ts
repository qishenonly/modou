import { randomUUID } from 'node:crypto';
import type { ApprovalGate } from '../permission/approval';
import { buildSystemPrompt } from '../prompt/system';
import type { ModelProvider } from '../provider/types';
import { TASK_TOOL_NAME } from '../tools/impl/task';
import { ToolRegistry } from '../tools/registry';
import {
  SUBAGENT_DEFAULT_MAX_TURNS,
  SUBAGENT_DEFAULT_TOOL_NAMES,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
  type WriteConflictReport,
} from '../tools/types';
import type { RunAgentTurnInput, RuntimeEvent, TurnResult } from './loop';

/**
 * 子代理派发器（T-120 Task 工具的实现侧，design 002 十节扩展点表：
 * 子代理 = 一个 Runtime 实例 + 独立 Session + agent 字段；ADR 0011）。
 *
 * 主代理的 loop 在 ToolContext 里注入 `runSubagent`（Task 工具经此派发）：
 * 派发一次子代理 = 用**派生注册表** + **子代理系统提示词** + **request.prompt
 * 首条 user 消息**再跑一次 `runAgentTurn`——独立的消息历史、独立的上下文窗口、
 * 独立的预算核算。父代理只拿到 `SubagentResult`（最终结论文本），子代理的内部
 * 过程不污染主上下文。
 *
 * 边界（ADR 0011 定稿，全部在代码层强制而非靠约定）：
 * - **一层深**：深度 ≥ 1 的 loop 里派发直接拒绝（子代理不能再派生子代理）；
 *   同时 `task` 工具永不进入子代理注册表（白名单过滤时剔除），双保险；
 * - **权限继承不超父**：子代理注册表从父代理注册表按白名单派生，父代理没有的
 *   工具名静默跳过；审批闸门与父代理共用同一实例（allow_always 记忆继承，
 *   天然是父已授予的权限）；
 * - **默认只读**：白名单缺省 = read / grep / glob 只读三件套；需要写入时由
 *   父代理（串行）执行，子代理只研究并回报结论；
 * - **独立预算**：子代理有自己的 maxTurns / maxTokens / timeoutMs，父代理的
 *   预算不向下传导；失败（超预算 / 超时 / 错误 / 中断）归一为 `ok:false`
 *   回喂主代理（错误即数据，002 5.3）。
 */

/** 一层深限制：子代理不能再派生子代理（ADR 0011 硬性限制）。 */
export const SUBAGENT_DEPTH_LIMIT = 1;

/**
 * 子代理系统提示词的追加段（拼在 buildSystemPrompt 的 extra 里）。
 * 声明子代理身份、任务形态与「只回最终结论」的输出期待。
 */
const SUBAGENT_INSTRUCTION = `## 子代理任务

你是主代理派出的子代理（supervisor 模式一层深，ADR 0011）：

- 你的任务见下方 user 消息——独立完成它，有自己的消息历史与上下文窗口，与主代理互不干扰；
- **只把最终结论返回给主代理**：结论要精炼、可操作，包含关键文件路径与行号；不要复述过程细节；
- 默认只有只读工具（read / grep / glob）：只做研究、不改动；若你的可用工具列表里没有写 / 执行工具，就只研究并把结论交回主代理执行后续改动；
- 子代理不能再派生子代理：不要尝试调用 task 工具（你也看不到它）。`;

/** 从父代理注册表派生子代理注册表（白名单是父代理子集，ADR 0011）。 */
export function deriveSubagentRegistry(
  parent: ToolRegistry | undefined,
  whitelist: readonly string[] | undefined,
): ToolRegistry {
  const derived = new ToolRegistry();
  if (parent === undefined) return derived;
  const names = whitelist ?? SUBAGENT_DEFAULT_TOOL_NAMES;
  for (const name of names) {
    // 父代理没有的工具名静默跳过：白名单是父代理子集，权限继承不超父
    const tool = parent.find(name);
    if (tool === undefined) continue;
    // 一层深：task 工具永不进入子代理注册表（即使父代理显式白名单放行）
    if (tool.name === TASK_TOOL_NAME) continue;
    derived.register(tool);
  }
  return derived;
}

/** 子代理系统提示词：普通系统提示词 + 子代理指令追加段。 */
export function buildSubagentSystemPrompt(registry: ToolRegistry): string {
  return buildSystemPrompt({ tools: registry, extra: SUBAGENT_INSTRUCTION });
}

/** 子代理派发器的构造选项（主代理 loop 装配后传入）。 */
export interface SubagentRunnerOptions {
  /**
   * 实际的 turn 内核（= runAgentTurn）。注入而非直接 import：subagent.ts 不
   * 依赖 loop.ts 的运行时符号，避免 runtime 内部的循环 import。
   */
  readonly runTurn: (
    input: RunAgentTurnInput,
    onEvent?: (event: RuntimeEvent) => void,
  ) => Promise<TurnResult>;
  /** 主代理的供应商（子代理用同一供应商实例）。 */
  readonly provider: ModelProvider;
  /** 主代理的工具注册表（子代理白名单从它派生）。缺省 = 子代理无工具。 */
  readonly parentRegistry: ToolRegistry | undefined;
  /** 会话级已读文件集合（共享同一 Set：子代理 Read 过的文件主代理可见可写）。 */
  readonly readFiles: Set<string>;
  /** 工作目录（子代理沿用主代理的 cwd）。 */
  readonly cwd: string;
  /** 审批闸门（与主代理共用同一实例——权限继承，allow_always 记忆继承）。 */
  readonly approval?: ApprovalGate;
  /** 主代理的中断信号（透传给子代理：主代理被打断时子代理同步停）。 */
  readonly abortSignal?: AbortSignal;
  /** 当前 loop 的深度：0 = 主代理，≥ SUBAGENT_DEPTH_LIMIT = 子代理。 */
  readonly depth: number;
  /**
   * 子代理事件转发出口（T-122）：子代理 loop 的每个 RuntimeEvent 包上 agentId
   * 作为 `subagent_event` 转出，bridge 据此按 agent 分发信封（前端按 ID 分组
   * 折叠）。缺省静默（不转发）。
   */
  readonly emit?: (event: RuntimeEvent) => void;
  /**
   * 写冲突检测钩子（T-123，ADR 0011）：透传主代理的 onFileWrite，子代理的
   * 每次成功写入按自身 agentId 上报——与主代理的 'main' 区分，跨 agent 同
   * 文件写入被检出冲突。缺省 = 不检测。
   */
  readonly onFileWrite?: (
    path: string,
    agent: string,
  ) => WriteConflictReport | undefined;
  /**
   * 钩子总线（T-142，0.14.0）：子代理继承主代理的 ④⑦ 钩子——钩子是统一的
   * 管线安全面，子代理的工具调用同样过钩子（deny / 改写 / 观察）。缺省 = 不挂。
   */
  readonly hooks?: import('../hooks/bus').HookBus;
}

/** 把子代理的终止归一为 SubagentResult（错误即数据）。导出：runtime/agent.ts 复用（0.17.0）。 */
export function toResult(agentId: string, result: TurnResult): SubagentResult {
  const base: SubagentResult = {
    ok: result.termination === 'end_turn',
    text: result.text,
    agentId,
    turns: result.turns,
    usage: {
      ...(result.usage.inputTokens !== undefined
        ? { inputTokens: result.usage.inputTokens }
        : {}),
      ...(result.usage.outputTokens !== undefined
        ? { outputTokens: result.usage.outputTokens }
        : {}),
    },
  };
  if (base.ok) return base;
  switch (result.termination) {
    case 'halted':
      return {
        ...base,
        error: '子代理预算超限：轮次 / token 超过上限，已终止（halted）',
      };
    case 'interrupted':
      return {
        ...base,
        error: '子代理被中断（interrupted），已产出文本部分返回',
      };
    case 'error':
      return {
        ...base,
        error: `子代理执行出错：${result.error?.message ?? '未知错误'}`,
      };
    default:
      return base;
  }
}

/** 组合多个中止信号：任一触发即中止；无信号时返回 undefined。导出：runtime/agent.ts 复用（0.17.0）。 */
export function combineSignals(
  signals: ReadonlyArray<AbortSignal | undefined>,
): AbortSignal | undefined {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

/** 构造子代理派发函数（Task 工具经 ToolContext.runSubagent 调用）。 */
export function createSubagentRunner(
  options: SubagentRunnerOptions,
): SubagentRunner {
  return async (request: SubagentRequest): Promise<SubagentResult> => {
    // —— 一层深硬限制（ADR 0011）：子代理不能再派生子代理 ——
    if (options.depth >= SUBAGENT_DEPTH_LIMIT) {
      return {
        ok: false,
        text: '',
        error:
          '子代理不能再派生子代理（一层深限制，ADR 0011）：本次任务由主代理直接完成或拆分后再派发。',
      };
    }

    const registry = deriveSubagentRegistry(
      options.parentRegistry,
      request.tools,
    );
    const system = buildSubagentSystemPrompt(registry);
    const agentId = `sub-${randomUUID().slice(0, 8)}`;

    // —— 墙钟超时（T-121 独立预算的一部分）：request.timeoutMs 到点即中止 ——
    // 定时器到点 → 中止超时信号 → 组合信号中止 → 子代理 provider 调用立即以
    // aborted 失败 → 子代理终止为 interrupted；下方据 timedOut 标志把结果归一
    // 为「超时」失败（而非普通中断），回喂主代理自纠（错误即数据，002 5.3）。
    let timedOut = false;
    let timeoutSignal: AbortSignal | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (request.timeoutMs !== undefined) {
      const controller = new AbortController();
      timeoutSignal = controller.signal;
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('子代理执行超时', 'TimeoutError'));
      }, request.timeoutMs);
    }

    // —— 独立预算 / 独立消息历史 / 独立上下文窗口 ——
    // 只传 request.prompt 首条 user 消息（不携带父代理历史）；maxTurns /
    // maxTokens 只取 request 自身的（父代理预算不向下传导）；同一 provider /
    // 审批闸门 / cwd / 已读集合。
    const subagentAbortSignal = combineSignals([
      options.abortSignal,
      timeoutSignal,
    ]);

    let result: TurnResult;
    try {
      result = await options.runTurn(
        {
          provider: options.provider,
          system,
          messages: [{ role: 'user', content: request.prompt }],
          // 派生的空注册表不传给模型（模型没有工具可用），与主 loop 的
          // tools 缺省语义一致
          ...(registry.size > 0 ? { tools: registry } : {}),
          readFiles: options.readFiles,
          cwd: options.cwd,
          approval: options.approval,
          options: {
            maxTurns: request.maxTurns ?? SUBAGENT_DEFAULT_MAX_TURNS,
            ...(request.maxTokens !== undefined
              ? { maxTokens: request.maxTokens }
              : {}),
            // 父中断信号 + 超时信号组合后透传给子代理
            ...(subagentAbortSignal !== undefined
              ? { abortSignal: subagentAbortSignal }
              : {}),
          },
          subagentDepth: SUBAGENT_DEPTH_LIMIT,
          // T-123：子代理的写入按自身 agentId 上报写冲突检测
          agentId,
          onFileWrite: (path) => options.onFileWrite?.(path, agentId),
          // T-142：子代理继承主代理的钩子总线（统一的管线安全面）
          ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
        },
        // T-122：子代理运行时事件包上 agentId 转出（bridge 据此按 agent 分发
        // 信封；前端按 ID 分组折叠展示子代理完整过程，主上下文不受污染）。
        (event) => {
          options.emit?.({ type: 'subagent_event', agent: agentId, event });
        },
      );
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    }

    // 0.12.1 修复：共享 Set 语义兑现——把子代理本地 readFiles 集合的增量并入
    // 父集合。子代理内部的 runAgentTurn 从父集合复制出独立集合，Read 过的文件
    // 只进了子代理副本；不回传的话，主代理后续 Edit/Write 该文件会被防盲写
    // 拒绝（文件已存在且主代理从未读过，002 5.2 防盲写覆盖）。
    for (const path of result.readFiles) {
      options.readFiles.add(path);
    }

    if (timedOut) {
      return {
        ok: false,
        text: result.text,
        agentId,
        turns: result.turns,
        error: `子代理执行超时（超过 ${String(request.timeoutMs)}ms，已中止）：任务未在时限内完成，请拆小或调整后重试`,
      };
    }

    return toResult(agentId, result);
  };
}
