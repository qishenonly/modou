/**
 * Hooks 领域类型（0.14.0，design 002 5.1 管线 ④⑦ 挂载点 + 生命周期扩展点）。
 *
 * 目标（phase-3 §0.14.0）：确定性脚本介入 agent 生命周期——模型不可靠的地方，
 * 用代码兜住。首批四个钩子点：
 *
 *   SessionStart     会话开始（本版只提供挂载点，未接入任何前端）
 *   UserPromptSubmit 用户提交提示词（可注入附加上下文 / 阻止提交）
 *   PreToolUse       工具执行前（④，可 deny 阻止 / 改写参数，理由回喂模型）
 *   PostToolUse      工具执行后（⑦，可观察 / 副作用，如编辑后自动 format）
 *
 * 契约稳定性（phase-3 §0.14.0 关键要点）：钩子拿到的输入是**第二个对外契约**
 * （工具名 / 参数 / cwd / 会话 ID），与事件流协议一样**只能加字段**。外部进程
 * 钩子走 JSON stdin/stdout（见 executor.ts）；本模块的 `Hook` 函数形态是
 * 总线内部表示，进程钩子由 executor 包装成它。
 */

/** 首批四个钩子点。 */
export type HookPoint =
  'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse';

/** 工具匹配器：钩子按工具名选择生效范围（仅 PreToolUse / PostToolUse 有意义）。 */
export interface ToolMatcher {
  /**
   * 工具名白名单；缺省或 `'*'` = 匹配全部工具。匹配只做精确名匹配，
   * 不做前缀 / 通配（0.4.0 的 deny 前缀挡不住 `bash -c` 绕过，钩子可以
   * 做任意复杂解析——但匹配器本身保持最简，复杂判断留给钩子脚本）。
   */
  readonly tools?: readonly string[] | '*';
}

/** 一次钩子执行的输入上下文（总线内部形态；进程钩子由此投影为 JSON 契约）。 */
export interface HookContext {
  readonly point: HookPoint;
  /** 会话 ID（未开会话 / 首轮提交前为 undefined）。 */
  readonly sessionId?: string;
  /** 工作目录（相对路径以此解析；缺省由执行器回落 process.cwd()）。 */
  readonly cwd?: string;
  // —— 工具点（PreToolUse / PostToolUse）——
  /** 工具名（工具点的匹配依据）。 */
  readonly toolName?: string;
  /** 工具入参（PreToolUse 钩子可改写；PostToolUse 钩子可观察）。 */
  readonly toolInput?: unknown;
  /** 工具执行结果（PostToolUse 钩子观察用：ok / 回喂模型的文本）。 */
  readonly toolResult?: {
    readonly ok: boolean;
    readonly forModel?: string;
  };
  // —— 用户提示词点（UserPromptSubmit）——
  /** 用户提交的提示词文本。 */
  readonly prompt?: string;
}

// ---------------------------------------------------------------------------
// 各钩子点的结果（判别联合）
// ---------------------------------------------------------------------------

/** SessionStart：会话开始钩子的结果（本版只提供挂载点；接线留待后续版本）。 */
export interface SessionStartHookResult {
  /** proceed = 照常开始；block = 阻止开始（执行器 fail-closed 降级时产生）。 */
  readonly decision: 'proceed' | 'block';
  readonly reason?: string;
}

/** UserPromptSubmit：可允许（注入附加上下文）或阻止提交。 */
export interface UserPromptSubmitHookResult {
  readonly decision: 'allow' | 'block';
  /** 阻止时的理由（对用户展示；允许时也可附带说明）。 */
  readonly reason?: string;
  /** 附加上下文：允许时拼接到用户提示词之后（可多行）。 */
  readonly additionalContext?: string;
}

/** PreToolUse：可允许（可改写参数）或阻止执行（理由回喂模型）。 */
export interface PreToolUseHookResult {
  readonly decision: 'allow' | 'deny';
  /** deny 时的理由——原样回喂模型（策略性拒绝，别重试同样的操作）。 */
  readonly reason?: string;
  /**
   * 改写的工具参数：命中时管线用改写后的参数执行（⑧ Record 与会话日志
   * 记录的也是改写后的形态）。改写不合法时按参数校验失败回喂模型。
   */
  readonly modifiedInput?: unknown;
}

/** PostToolUse：本版恒 continue（观察 / 副作用，不改变工具结果）。 */
export interface PostToolUseHookResult {
  readonly decision: 'continue';
  readonly reason?: string;
}

/** 各钩子点的结果联合（总线运行产出的原始结果）。 */
export type HookResult =
  | SessionStartHookResult
  | UserPromptSubmitHookResult
  | PreToolUseHookResult
  | PostToolUseHookResult;

/** 一次钩子执行（总线注册 / 运行的函数形态）。崩溃不得向上抛——执行器把它归为降级。 */
export type Hook = (context: HookContext) => Promise<HookResult>;

/** 总线运行方式的并发度：串行（注册顺序，保证顺序）或并发（Promise.all）。 */
export type HookConcurrency = 'serial' | 'concurrent';

/** 单个钩子注册的元数据。 */
export interface HookRegistration {
  /** 全局唯一 ID（注册时生成或注入；重复注册抛错）。 */
  readonly id: string;
  readonly point: HookPoint;
  /** 工具匹配器（缺省 = 匹配全部；非工具点忽略）。 */
  readonly matcher?: ToolMatcher;
  readonly hook: Hook;
}

/** HookBus.run 的返回：每个匹配钩子的执行结果（含崩溃记录）。 */
export interface HookOutcome {
  readonly registration: HookRegistration;
  /** 钩子函数返回的结果；钩子崩溃（抛异常）时为 undefined（error 非空）。 */
  readonly result?: HookResult;
  /** 钩子崩溃的异常（执行器已将进程崩溃转为降级结果时为空——此处只兜底内联钩子）。 */
  readonly error?: unknown;
}
