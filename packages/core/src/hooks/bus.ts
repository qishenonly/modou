/**
 * HookBus —— 生命周期总线（T-140）。
 *
 * 把已有的关键节点抽成可挂载的钩子点，按「钩子点 + 工具匹配器」注册 / 执行：
 *
 * - `register(point, hook, options?)`：注册一个钩子。工具匹配器（matcher.tools）
 *   决定 PreToolUse / PostToolUse 的生效工具范围；SessionStart / UserPromptSubmit
 *   没有工具维度，匹配器忽略。重复 ID 注册抛错（编程错误，不静默覆盖）。
 * - `run(point, context, options?)`：找出该钩子点下所有匹配的钩子，按串行或
 *   并发执行，返回每个钩子的结果（含崩溃记录，不中断批次）。
 *
 * 并发度：`serial`（注册顺序逐个 await，保证顺序）或 `concurrent`（Promise.all，
 * 结果仍按注册顺序返回）。缺省串行——工具钩子的语义是「拦截判定」，顺序稳定
 * 才好预测（首个 deny 即阻止，后续钩子仍执行但结果被聚合函数合并）。
 *
 * 与执行器（T-141 executor.ts）的分工：总线只做注册与编排，不感知进程；外部
 * 进程钩子由执行器包装成 `Hook`（JSON stdin/stdout + 超时 + 失败降级 + 执行
 * 日志）后注册进来。崩溃的兜底分两层：执行器把进程崩溃转为降级结果（fail-open/
 * fail-closed，绝不向上抛）；内联钩子（测试 / 内存实现）若抛异常，总线捕获并
 * 记入 `HookOutcome.error`，批次不中断——由聚合函数（run.ts）按保守策略裁决。
 */

import type {
  Hook,
  HookContext,
  HookConcurrency,
  HookOutcome,
  HookPoint,
  HookRegistration,
  ToolMatcher,
} from './types';

/** 单个钩子的注册选项。 */
export interface HookRegistrationOptions {
  /** 注册 ID（缺省自动生成）。重复 ID 抛错。 */
  readonly id?: string;
  /** 工具匹配器（缺省 = 匹配全部；非工具点忽略）。 */
  readonly matcher?: ToolMatcher;
}

/** HookBus.run 的运行选项。 */
export interface HookRunOptions {
  /** 并发度（缺省串行：注册顺序逐个 await）。 */
  readonly concurrency?: HookConcurrency;
}

/** 自增注册 ID 计数器（保证同一总线内 ID 唯一且有序）。 */
let registrationCounter = 0;

/** 生成一个稳定的注册 ID：`hook-<序号>`。 */
function nextRegistrationId(): string {
  registrationCounter += 1;
  return `hook-${registrationCounter}`;
}

/** 匹配器是否命中：缺省 / '*' / 空白名单 = 命中全部；否则按工具名精确匹配。 */
export function matchesTool(
  matcher: ToolMatcher | undefined,
  toolName: string | undefined,
): boolean {
  if (matcher === undefined) return true;
  const tools = matcher.tools;
  if (tools === undefined || tools === '*') return true;
  if (toolName === undefined) return false;
  return tools.includes(toolName);
}

/**
 * 生命周期总线（T-140）。线程模型：注册线程安全（Map 读写，同步）；
 * 运行并发安全（每次 run 独立批次，互不共享可变状态）。
 */
export class HookBus {
  private readonly registrations = new Map<HookPoint, HookRegistration[]>();
  private readonly defaultConcurrency: HookConcurrency;

  constructor(options: { readonly concurrency?: HookConcurrency } = {}) {
    this.defaultConcurrency = options.concurrency ?? 'serial';
  }

  /**
   * 注册一个钩子。重复 ID 抛错（编程错误：钩子名必须唯一，防静默覆盖）；
   * 重复 point 允许（同点可挂多个钩子，按注册顺序执行）。
   */
  register(
    point: HookPoint,
    hook: Hook,
    options: HookRegistrationOptions = {},
  ): this {
    const id = options.id ?? nextRegistrationId();
    const bucket = this.registrations.get(point) ?? [];
    if (bucket.some((existing) => existing.id === id)) {
      throw new Error(
        `钩子 "${id}" 重复注册：同一总线内钩子 ID 必须唯一（防止静默覆盖）`,
      );
    }
    bucket.push({ id, point, matcher: options.matcher, hook });
    this.registrations.set(point, bucket);
    return this;
  }

  /** 已注册的钩子（按点分组，组内按注册顺序；point 缺省 = 全部点）。 */
  list(point?: HookPoint): readonly HookRegistration[] {
    if (point !== undefined) {
      return [...(this.registrations.get(point) ?? [])];
    }
    const all: HookRegistration[] = [];
    for (const point of Object.keys(this.registrations) as HookPoint[]) {
      all.push(...(this.registrations.get(point) ?? []));
    }
    return all;
  }

  /** 某钩子点下是否有注册（含匹配器未命中的情况——只要有点级注册即 true）。 */
  has(point: HookPoint): boolean {
    return (this.registrations.get(point)?.length ?? 0) > 0;
  }

  /**
   * 执行某钩子点下所有**匹配**的钩子，返回每个钩子的结果（含崩溃记录）。
   *
   * - 匹配：PreToolUse / PostToolUse 按 context.toolName 与注册匹配器比对，
   *   不命中跳过；其余点全部执行；
   * - 并发度：run 选项优先，否则总线构造时的缺省；
   * - 崩溃兜底：钩子抛异常被捕获记入 `outcome.error`，批次继续（内联钩子的
   *   降级裁决由聚合函数 run.ts 按保守策略做；进程钩子已在执行器层降级）。
   */
  async run(
    point: HookPoint,
    context: HookContext,
    options: HookRunOptions = {},
  ): Promise<HookOutcome[]> {
    const bucket = this.registrations.get(point) ?? [];
    // 工具匹配器只对工具点（PreToolUse / PostToolUse）生效——用户提示词 /
    // 会话级钩子没有工具维度，注册在它们下面的 matcher 一律不拦截。
    const isToolPoint = point === 'PreToolUse' || point === 'PostToolUse';
    const matched = bucket.filter((registration) =>
      isToolPoint ? matchesTool(registration.matcher, context.toolName) : true,
    );
    if (matched.length === 0) return [];
    const concurrency = options.concurrency ?? this.defaultConcurrency;

    const execute = async (
      registration: HookRegistration,
    ): Promise<HookOutcome> => {
      try {
        const result = await registration.hook({ ...context, point });
        return { registration, result };
      } catch (error) {
        return { registration, error };
      }
    };

    if (concurrency === 'serial') {
      const outcomes: HookOutcome[] = [];
      for (const registration of matched) {
        outcomes.push(await execute(registration));
      }
      return outcomes;
    }
    return Promise.all(matched.map((registration) => execute(registration)));
  }
}
