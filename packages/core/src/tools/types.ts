import { z } from 'zod';

/**
 * 工具子系统领域类型（design 002 5.2 / 5.3 / 5.4）。
 * 目录边界：tools/ 只依赖 zod 与 ../protocol/events，禁止依赖 runtime / provider。
 */

/** 工具风险分类（002 5.2）：给 Permission 裁决用的分类维度，不是自由文本。 */
export type ToolRisk = 'read' | 'write' | 'exec' | 'network';

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
