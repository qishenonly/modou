import { rm } from 'node:fs/promises';
import type { ModelMessage } from 'ai';
import type { CompactOptions } from '../context/compact';
import { createModelDeltaGenerator } from '../context/delta';
import { ApprovalGate } from '../permission/approval';
import { buildSystemPrompt } from '../prompt/system';
import type { ModelProvider } from '../provider/types';
import { runAgentTurn } from '../runtime/loop';
import type { RuntimeEvent, TurnResult } from '../runtime/loop';
import { defaultWriteTools } from '../tools';
import type { ToolRegistry } from '../tools/registry';
import { copyFixture } from './fixtures';
import { collectMetrics } from './metrics';
import type { EvalMetrics } from './metrics';
import type { EvalTask, JudgeResult } from './types';

/**
 * 评测运行器（T-035 骨架 / T-090 扩充）。
 *
 * runEval 流程：复制 fixture 到临时目录 → 以该目录为 cwd 驱动 agent loop
 * （provider 可注入：骨架用 stub，0.9.0 注入真实模型）→ 跑 judge →
 * 采集度量（工具成功率 / 编辑一次命中率 / 压缩次数 / token 基线）→ 返回
 * pass/fail。
 *
 * 长任务压缩用例（T-090）：任务可携带 `compact` 配置（types.ts），runEval
 * 把它传给 loop（T-070），loop 在上下文估算超阈值且迟滞窗口已过时触发增量
 * 压缩；未注入摘要生成函数时缺省装配生产生成器（createModelDeltaGenerator，
 * 用真实模型生成增量摘要），离线测试经 RunEvalOptions.compact 整体覆盖注入
 * stub。压缩次数经 events 采进 `metrics.compactions`，供 runSuite 聚合
 * 「压缩后任务延续率」。
 *
 * 写入 / 执行工具在评测场景一律放行（无人值守，autoApprove 语义），
 * 但判定只看产物（测试是否变绿 / 文件是否含目标实现），不信任模型自述。
 */

/** runEval 选项。 */
export interface RunEvalOptions {
  /** 模型供应商（骨架注入 stub；0.9.0 注入真实模型实例）。 */
  readonly provider: ModelProvider;
  /** 评测任务。 */
  readonly task: EvalTask;
  /** 轮次上限（缺省用 task.maxTurns ?? 10）。 */
  readonly maxTurns?: number;
  /**
   * 初始消息线程（T-090 长任务离线用例）：缺省 = `[{ role: 'user',
   * content: task.prompt }]`；测试可注入含 40+ 轮用户历史的线程，
   * 驱动 loop 的压缩折叠（splitThreadIntoTurns 按 user 消息分轮）。
   */
  readonly messages?: readonly ModelMessage[];
  /**
   * 压缩配置（T-070）：提供时覆盖 task.compact 整体传入 loop；
   * 缺省取 task.compact。未注入 generateDelta 时由本模块装配生产生成器。
   */
  readonly compact?: CompactOptions;
  /**
   * 工作目录覆盖：缺省自动复制 fixture 到临时目录并作为 cwd；
   * 测试可预置固定 fixture 副本（此时不复制、也不清理该目录）。
   */
  readonly cwd?: string;
  /** 系统提示词（缺省 buildSystemPrompt(defaultWriteTools())）。 */
  readonly system?: string;
  /** 工具注册表（缺省 defaultWriteTools()：read/grep/glob/write/edit/bash）。 */
  readonly tools?: ToolRegistry;
  /** 运行后是否删除自动创建的临时目录（缺省 true；注入 cwd 时忽略）。 */
  readonly cleanup?: boolean;
}

/** 单条任务运行结果。 */
export interface EvalTaskRunResult {
  readonly task: EvalTask;
  /** 判定是否通过。 */
  readonly pass: boolean;
  readonly judge: JudgeResult;
  readonly metrics: EvalMetrics;
  /** 模型最终文本（读代码答问判定依据；可留档回放）。 */
  readonly text: string;
  /** 终止原因（end_turn / halted / error / interrupted）。 */
  readonly termination: TurnResult['termination'];
  /** 实际轮次（模型请求数）。 */
  readonly turns: number;
  /** 运行耗时（毫秒）。 */
  readonly durationMs: number;
  /** 工作目录（自动创建的临时目录或注入的 cwd；清理后路径可能已不存在）。 */
  readonly workspace: string;
}

/** 评测用审批闸门：一律放行（评测无人值守，write / exec 免确认）。 */
function evalApprovalGate(): ApprovalGate {
  return new ApprovalGate({
    decider: async () => ({ decision: 'allow_once', source: 'policy' }),
  });
}

/**
 * 运行一条评测任务。
 * 运行本身异常（loop 不变量破坏等）时先释放临时目录再原样抛出；
 * judge 判定失败只是返回 pass=false，不算异常。
 */
export async function runEval(
  options: RunEvalOptions,
): Promise<EvalTaskRunResult> {
  const { task, provider } = options;
  const maxTurns = options.maxTurns ?? task.maxTurns ?? 10;
  const tools = options.tools ?? defaultWriteTools();
  const system = options.system ?? buildSystemPrompt({ tools });

  // 初始消息：注入 messages（长任务离线用例的 40+ 轮线程）或缺省任务 prompt
  const initialMessages: ModelMessage[] =
    options.messages !== undefined && options.messages.length > 0
      ? [...options.messages]
      : [{ role: 'user', content: task.prompt }];

  // 压缩配置（T-070）：options.compact 优先，缺省取 task.compact；提供了
  // compact 但未注入摘要生成函数时，装配生产生成器（createModelDeltaGenerator
  // 调 provider 生成增量摘要）——真实模型评测长任务压缩用例的默认路径。
  let compact: CompactOptions | undefined = options.compact ?? task.compact;
  if (compact !== undefined && compact.generateDelta === undefined) {
    compact = {
      ...compact,
      generateDelta: createModelDeltaGenerator(provider),
    };
  }

  // 工作目录：注入 cwd（测试预置）或缺省复制 fixture 到临时目录
  let workspace: string;
  let createdTempDir = false;
  if (options.cwd !== undefined) {
    workspace = options.cwd;
  } else {
    workspace = await copyFixture(task.fixture);
    createdTempDir = true;
  }

  const cleanup = options.cleanup ?? true;
  const startedAt = Date.now();
  const events: RuntimeEvent[] = [];
  let result: TurnResult;
  try {
    result = await runAgentTurn(
      {
        provider,
        system,
        messages: initialMessages,
        tools,
        approval: evalApprovalGate(),
        readFiles: new Set<string>(),
        cwd: workspace,
        compact,
        options: { maxTurns },
      },
      (event) => {
        events.push(event);
      },
    );
  } catch (error) {
    if (createdTempDir && cleanup) {
      await rm(workspace, { recursive: true, force: true });
    }
    throw error;
  }

  const durationMs = Date.now() - startedAt;
  const metrics = collectMetrics(
    events,
    result.text,
    result.turns,
    result.usage,
  );
  const judge = await task.judge({
    dir: workspace,
    text: result.text,
    task,
  });

  if (createdTempDir && cleanup) {
    await rm(workspace, { recursive: true, force: true });
  }

  return {
    task,
    pass: judge.pass,
    judge,
    metrics,
    text: result.text,
    termination: result.termination,
    turns: result.turns,
    durationMs,
    workspace,
  };
}

/** runSuite 选项：任务列表 + 按任务构造供应商（评测脚本可返回共享真实模型实例）。 */
export interface RunSuiteOptions {
  readonly tasks: readonly EvalTask[];
  /** 按任务构造供应商（真实模型评测返回共享实例；测试按任务注入 stub）。 */
  readonly provider: (task: EvalTask) => ModelProvider | Promise<ModelProvider>;
  /** 透传给每个 runEval 的附加选项（maxTurns / cwd / tools 等）。 */
  readonly run?: Omit<RunEvalOptions, 'provider' | 'task'>;
  /**
   * 按任务覆盖 run 选项（优先于 run；测试用：给 long-mathlib 注入
   * 40+ 轮线程 + stub 压缩配置，给 fix 任务注入预置 cwd 等）。
   */
  readonly runForTask?: (
    task: EvalTask,
  ) => Omit<RunEvalOptions, 'provider' | 'task'>;
}

/** token 基线（0.9.0 五项指标之五）：从各任务的 TurnResult.usage 聚合。 */
export interface EvalTokenBaseline {
  /** 全部任务的累计输入 token（供应商 usage；缺失按 0）。 */
  readonly totalInputTokens: number;
  /** 全部任务的累计输出 token。 */
  readonly totalOutputTokens: number;
  /** 累计 token（输入 + 输出）。 */
  readonly totalTokens: number;
  /** 平均 token / 任务（token 基线的主要读数）。 */
  readonly avgTokensPerTask: number;
}

/** 整套评测的聚合结果（T-091 五项度量）。 */
export interface EvalSuiteResult {
  readonly results: readonly EvalTaskRunResult[];
  /** 度量一：任务完成率（通过 / 总数）。 */
  readonly taskCompletionRate: number;
  /** 度量二：聚合工具调用成功率（Σ成功 / Σ调用；无调用时 undefined）。 */
  readonly toolSuccessRate?: number;
  /** 度量三：聚合编辑一次命中率（Σ命中 / Σ编辑调用；无编辑时 undefined）。 */
  readonly editHitRate?: number;
  /** 度量四分母：发生压缩的任务数（metrics.compactions > 0）。 */
  readonly compactionCandidates: number;
  /** 度量四分子：压缩且判定通过的任务数。 */
  readonly compactionContinuations: number;
  /**
   * 度量四：压缩后任务延续率（延续 / 候选）。语义 = 压缩发生的任务里，
   * judge 仍通过的比例——「压缩后仍准确记得初始需求与未完成项」的观测值
   * （G-0.7.0 / G-0.9.0）。无压缩任务时 undefined。
   */
  readonly compactionContinuationRate?: number;
  /** 度量五：token 基线（累计 usage 聚合）。 */
  readonly tokenBaseline: EvalTokenBaseline;
  readonly totalDurationMs: number;
}

/**
 * 跑完一组评测任务，聚合出五项度量。
 * 串行执行（工具默认串行、共享模型实例安全），逐个产出可在中途收集进度。
 */
export async function runSuite(
  options: RunSuiteOptions,
): Promise<EvalSuiteResult> {
  const startedAt = Date.now();
  const results: EvalTaskRunResult[] = [];
  for (const task of options.tasks) {
    const provider = await options.provider(task);
    const perTask = options.runForTask?.(task) ?? {};
    results.push(await runEval({ task, provider, ...options.run, ...perTask }));
  }

  const toolCalls = results.reduce((acc, r) => acc + r.metrics.toolCalls, 0);
  const toolSuccesses = results.reduce(
    (acc, r) => acc + r.metrics.toolSuccesses,
    0,
  );
  const editCalls = results.reduce((acc, r) => acc + r.metrics.editCalls, 0);
  const editHits = results.reduce((acc, r) => acc + r.metrics.editHits, 0);
  const passes = results.filter((r) => r.pass).length;

  // 压缩后延续率：发生压缩的任务里 judge 仍通过的比例
  const compactedResults = results.filter((r) => r.metrics.compactions > 0);
  const compactionCandidates = compactedResults.length;
  const compactionContinuations = compactedResults.filter((r) => r.pass).length;

  // token 基线：从各任务的 TurnResult.usage（供应商校准口径）聚合
  const totalInputTokens = results.reduce(
    (acc, r) => acc + (r.metrics.usage.inputTokens ?? 0),
    0,
  );
  const totalOutputTokens = results.reduce(
    (acc, r) => acc + (r.metrics.usage.outputTokens ?? 0),
    0,
  );
  const totalTokens = totalInputTokens + totalOutputTokens;

  return {
    results,
    taskCompletionRate: passes / results.length,
    toolSuccessRate: toolCalls > 0 ? toolSuccesses / toolCalls : undefined,
    editHitRate: editCalls > 0 ? editHits / editCalls : undefined,
    compactionCandidates,
    compactionContinuations,
    compactionContinuationRate:
      compactionCandidates > 0
        ? compactionContinuations / compactionCandidates
        : undefined,
    tokenBaseline: {
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      avgTokensPerTask: results.length > 0 ? totalTokens / results.length : 0,
    },
    totalDurationMs: Date.now() - startedAt,
  };
}
