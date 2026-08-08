import { z } from 'zod';

/**
 * 工具子系统领域类型（design 002 5.2 / 5.3 / 5.4）。
 * 目录边界：tools/ 只依赖 zod 与 ../protocol/events，禁止依赖 runtime / provider；
 * 例外是 toolset.ts 的 AI SDK v7 类型互操作（tool()/jsonSchema()，只声明不执行，
 * 是工具定义发给模型的唯一通道）。
 */

/** 工具风险分类（002 5.2）：给 Permission 裁决用的分类维度，不是自由文本。 */
export type ToolRisk = 'read' | 'write' | 'exec' | 'network';

/**
 * TodoWrite 清单条目（与 context/summary 的 SummaryItem 结构共用——ADR 0010：
 * 清单与压缩状态同一结构，压缩时清单不丢）。tools 边界内自持结构类型，
 * 不 import context；运行时（loop）据此适配进会话结构化状态。
 */
export interface TodoWriteItem {
  readonly id?: string;
  readonly text: string;
  readonly status: 'pending' | 'in_progress' | 'done';
  /** 依赖的其他待办 id（可选）。 */
  readonly dependsOn?: readonly string[];
}

/** 一次 TodoWrite 的清单更新（全量期望清单，模型每次带全部条目）。 */
export interface TodoUpdate {
  readonly items: readonly TodoWriteItem[];
}

// ---------------------------------------------------------------------------
// 子代理（T-120 Task 工具，ADR 0011）
// ---------------------------------------------------------------------------

/** 子代理缺省轮次上限：request 未传 maxTurns 时的兜底（runtime/subagent.ts 消费）。 */
export const SUBAGENT_DEFAULT_MAX_TURNS = 10;

/** 子代理缺省工具白名单：只读三件套（ADR 0011「子代理默认只读」）。 */
export const SUBAGENT_DEFAULT_TOOL_NAMES: readonly string[] = [
  'read',
  'grep',
  'glob',
];

/**
 * 子代理请求（Task 工具入参经过校验后的形态）：派生子代理执行的任务描述与预算。
 */
export interface SubagentRequest {
  /** 交给子代理的完整指令（作为子代理对话的首条 user 消息）。 */
  readonly prompt: string;
  /**
   * 工具白名单（父代理工具名的子集，缺省 = 只读三件套）。白名单外的工具名
   * 静默跳过——子代理永远拿不到父代理没有的工具（权限继承不超父，ADR 0011）。
   */
  readonly tools?: readonly string[];
  /** 子代理轮次上限（独立于父代理；缺省 SUBAGENT_DEFAULT_MAX_TURNS）。 */
  readonly maxTurns?: number;
  /** 子代理 token 预算（独立核算，父代理不合并；缺省不限）。 */
  readonly maxTokens?: number;
  /** 子代理墙钟超时（毫秒；缺省不限——靠 maxTurns/maxTokens 预算兜底）。 */
  readonly timeoutMs?: number;
}

/**
 * 子代理执行结果：只向主循环返回最终结论文本（独立消息历史 / 独立上下文窗口
 * 的产物，父代理不接触子代理的内部过程）。
 */
export interface SubagentResult {
  /** 子代理正常收尾（end_turn）为 true；超预算 / 超时 / 错误 / 一层深拒绝为 false。 */
  readonly ok: boolean;
  /** 最终结论文本（失败时为已产出的部分文本或诊断信息）。 */
  readonly text: string;
  /** ok:false 时的失败原因（depth 限制 / 超时 / 预算超限 / 终止原因等）。 */
  readonly error?: string;
  /** 子代理 ID（事件流 agent 字段；T-122 前端按此分组折叠）。 */
  readonly agentId?: string;
  /** 子代理实际完成的轮次（模型请求数）。 */
  readonly turns?: number;
  /** 子代理独立核算的 token 用量（不并入父代理 usage）。 */
  readonly usage?: Readonly<{
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  }>;
}

/**
 * 子代理派发函数：由运行时注入 ToolContext（Task 工具经此派发），
 * 实现 = 一次独立的 `runAgentTurn`（runtime/subagent.ts，ADR 0011）。
 */
export type SubagentRunner = (
  request: SubagentRequest,
) => Promise<SubagentResult>;

// ---------------------------------------------------------------------------
// 写冲突检测（T-123，ADR 0011）
// ---------------------------------------------------------------------------

/**
 * 写冲突报告（T-123）：同一文件被另一 agent 先写入后，当前 agent 再次写入时
 * 返回的冲突信息。前端 / 用户据此核对「改动可能互相覆盖」。
 */
export interface WriteConflictReport {
  /** 冲突的文件路径（工具上报的解析后绝对路径）。 */
  readonly path: string;
  /** 本次写入的 agent（'main' 或子代理 ID）。 */
  readonly agent: string;
  /** 此前已写入同一文件的另一 agent。 */
  readonly existingAgent: string;
  /** 既有写入的时间戳（epoch ms）。 */
  readonly existingAt: number;
}

/**
 * 写冲突检测钩子（运行时/调用方注入）：每次工具成功写入一个文件后调用，
 * 返回冲突报告（同一文件此前已被另一 agent 写入）或 undefined（无冲突 /
 * 同一 agent 连续写入）。agent 参数：'main' = 主代理，子代理用自身 ID。
 */
export type OnFileWrite = (
  path: string,
  agent: string,
) => WriteConflictReport | undefined;

/** 工具执行上下文。0.2.0 最小集：组合取消信号 + 工作目录。 */
export interface ToolContext {
  /**
   * 组合信号：管线把「执行超时」与「外部 abort」合并成一个信号传给工具，
   * 工具应配合做协作式取消（监听 abort，尽快返回失败结果）。
   */
  readonly signal: AbortSignal;
  /** 当前工作目录（后续 Read/Grep/Bash 用）。 */
  readonly cwd?: string;
  /** 项目根目录。 */
  readonly projectRoot?: string;
  /**
   * 本会话已读过的文件（绝对路径集合，T-030 Write 的防盲写依赖）。
   * 由运行时维护：Read 工具成功读到的文件路径入集，随工具上下文下发；
   * 集合为只读快照，工具不得改写。Write 覆盖已有文件时要求该文件
   * 在集合内（防盲写覆盖）；新文件不受此限。测试可注入该集合。
   */
  readonly readFiles?: ReadonlySet<string>;
  /**
   * 已读文件上报回调（维护会话已读集合的唯一入口）：Read 工具成功读到
   * 一个文件后调用，入参是该文件 realpath 解析后的绝对路径；运行时（loop）
   * 据此把路径加入会话级已读集合，使后续 Write/Edit 的防盲写检查放行。
   * 回调是同步的（read 工具只上报、不等待）；缺省时不调用。选此方案而非
   * 「loop 事后解析 read 的 payload.path」：读方自报成功读到哪个文件，
   * 不把 loop 与 read 工具的 payload 结构耦合在一起。
   */
  readonly onFileRead?: (path: string) => void;
  /**
   * 待办更新上报回调（TodoWrite 工具的持久化通道，T-110）：工具每次更新
   * 清单后调用（全量期望清单），运行时据此把清单写入会话内结构化状态
   * （TodoState）与会话日志（todo_update 条目，/resume 可重建）。回调同步、
   * 缺省不调用——与 onFileRead 同一设计：写方自报更新，不把 loop 与工具的
   * payload 结构耦合。
   */
  readonly onTodoUpdate?: (update: TodoUpdate) => void;
  /**
   * 子代理派发通道（T-120 Task 工具）：运行时注入，Task 工具 execute 经它派出
   * 子代理（独立 runAgentTurn、独立消息历史、独立上下文窗口），只拿回最终结论
   * 文本。缺省不提供——未注入时 Task 工具返回「子代理不可用」失败结果（错误即
   * 数据）。一层深限制由运行时强制：子代理 loop 内的 runSubagent 直接拒绝
   * （ADR 0011）。
   */
  readonly runSubagent?: SubagentRunner;
  /**
   * 写入上报回调（T-123 写冲突检测）：write / edit 工具成功落盘后调用，入参是
   * 实际写入的文件路径（解析后绝对路径）。运行时据此维护会话级写冲突检测
   * （onFileWrite 注入，ADT 0011）。回调同步、缺省不调用——写方自报，不把
   * loop 与工具的 payload 结构耦合。
   */
  readonly onFileWrite?: (path: string) => void;
}

/**
 * 截断信息（002 5.4「截断要出声」）：有没有截断、各省略了多少。
 * 由管线 Normalize 步骤填写；工具若自行截断也可提前声明，管线负责合并。
 */
export interface TruncationInfo {
  readonly truncated: boolean;
  /** 省略的行数（行级截断时存在）。 */
  readonly omittedLines?: number;
  /** 省略的字符数（字符级截断时存在）。 */
  readonly omittedChars?: number;
}

/**
 * 工具执行结果（002 5.3 错误即数据）：失败是返回值不是异常。
 * - `forModel`：喂给模型的纯文本。成功 = 输出内容；失败 = 可诊断错误
 *   （参数错附正确用法、执行错附原因、超时写明超时），供模型自纠；
 * - `payload`：给前端渲染的结构化载荷（如 diff、文件列表），模型看不到；
 * - `summary`：给人看的结果摘要，缺省由管线取 forModel 首行；
 * - `truncated`：截断信息，管线 Normalize 填写（002 5.4）。
 */
export interface ToolOutcome {
  readonly ok: boolean;
  readonly forModel: string;
  readonly payload?: unknown;
  readonly summary?: string;
  readonly truncated?: TruncationInfo;
}

/**
 * 工具契约（002 5.2）。schema 兼做两件事：
 * 参数校验（②Validate）与自动生成给模型的 JSON Schema（①/系统提示词用）。
 * `execute` 必须返回 ToolOutcome，禁止抛异常当失败——失败要回喂模型自纠。
 * 泛型默认用 `any` 输出类型：注册表 / 管线按任意 schema 处理；具体工具在
 * 定义处用 `Tool<typeof schema>` 拿到精确的 args 类型。
 */
export interface Tool<
  TSchema extends z.ZodType<any, any> = z.ZodType<any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- zod 泛型约束的标准写法
> {
  readonly name: string;
  /** 进上下文的说明，是提示词工程的一部分。 */
  readonly description: string;
  readonly schema: TSchema;
  readonly risk: ToolRisk;
  /**
   * 并发执行标记（T-123 子代理）：标为 true 的工具在同一轮被多次调用时由 loop
   * 并行执行（Promise.all 派发、结果按调用顺序聚合）——适用于互不共享状态、
   * 无文件写副作用的工具（如 task 子代理派发，ADR 0011 默认只读因此并行安全）。
   * 缺省 = 串行执行（002 十一「工具默认串行落地」，换取可预测性；并发写同一
   * 文件必然丢改动）。
   */
  readonly concurrent?: boolean;
  readonly execute: (
    args: z.infer<TSchema>,
    ctx: ToolContext,
  ) => Promise<ToolOutcome>;
}

/** 运行时结构守卫：判断一个值是否合法的 ToolOutcome。 */
export function isToolOutcome(value: unknown): value is ToolOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ToolOutcome>;
  return (
    typeof candidate.ok === 'boolean' && typeof candidate.forModel === 'string'
  );
}
