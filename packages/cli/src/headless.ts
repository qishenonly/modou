import {
  buildSystemPrompt,
  defaultReadonlyTools,
  runAgentTurnStreaming,
  type Envelope,
  type ModelProvider,
  type ProviderError,
  type ProviderErrorKind,
  type RetryOptions,
  type ToolRegistry,
  type TurnResult,
} from '@modou/core';

/**
 * headless 消费端（`modou -p` 的实现）。
 *
 * 铁律：cli 只 import core 的公开 API（@modou/core），core 零 UI 依赖
 * 因此保持。headless 拿到的是纯协议信封，不触碰 core 内部对象。
 *
 * 输出策略：
 * - `text_delta` → stdout（无 TTY 的 headless 输出，stdout 保持纯回答文本）；
 * - 收尾的 usage 摘要与错误 / 上限 / 中断提示 → stderr，
 *   这样 `modou -p "..." > out.txt` 得到的 out.txt 是干净的答案。
 */

export interface HeadlessOptions {
  /** 装配好的模型供应商（测试注入假 provider；main 负责装配）。 */
  readonly provider: ModelProvider;
  /** 用户提示词。 */
  readonly prompt: string;
  /**
   * 系统指令（可选）。缺省用 core 生成的系统提示词
   * （buildSystemPrompt(defaultReadonlyTools())：身份 / 搜索优先策略 / 工具说明）；
   * 传入则完全覆盖，测试可注入自定义 system。
   */
  readonly system?: string;
  /** 轮次上限（默认 10）。 */
  readonly maxTurns?: number;
  /**
   * 中断信号（T-014：SIGINT/SIGTERM 的 AbortController.signal）。
   * 触发后本轮终止为 interrupted，已产文本照常输出。
   */
  readonly abortSignal?: AbortSignal;
  /**
   * 工具注册表（可注入覆盖）。缺省用 defaultReadonlyTools()（read / grep /
   * glob，与缺省系统提示词声明的工具集一致）；测试可注入 stub 注册表。
   */
  readonly tools?: ToolRegistry;
  /** 供应商错误的退避重试参数（缺省用默认值；测试注入 0 延迟）。 */
  readonly retry?: RetryOptions;
  /** stdout 写入器（默认 process.stdout.write；测试注入收集器）。 */
  readonly write?: (chunk: string) => void;
  /** stderr 写入器（默认 process.stderr.write；测试注入收集器）。 */
  readonly writeError?: (chunk: string) => void;
}

export interface HeadlessResult {
  /** 本次运行的 TurnResult（usage / termination 等）。 */
  readonly result: TurnResult;
  /** 本次运行产出的全部协议信封（测试断言用）。 */
  readonly envelopes: readonly Envelope[];
}

/** 面向用户的简短建议（design 002 5.3 处置表 → 用户侧措辞）。 */
const ERROR_ADVICE: Readonly<Record<ProviderErrorKind, string>> = {
  rate_limited: '稍后重试',
  server_error: '稍后重试',
  timeout: '稍后重试',
  invalid_api_key: '检查 API Key 配置',
  auth: '检查 API 权限配置',
  not_found: '检查模型 / 端点配置',
  bad_request: '检查请求参数',
  aborted: '请求已取消',
  unknown: '未知错误',
};

/**
 * 把终止错误渲染成面向用户的诊断信息（002 5.3「错误即数据」）：
 * - 供应商错误：错误分类 + 是否可重试 + 简短建议；
 * - 内部错误（category 'internal'，适配器 bug / 未知异常）：不回喂模型，
 *   直接报用户并提示报告 —— 用户侧的「非 0 退出码」由 main 决定。
 */
export function renderErrorDiagnostics(
  error: ProviderError | undefined,
): string {
  if (error === undefined) return '未知错误';
  if (error.category === 'internal') {
    return `内部错误：${error.message}（非供应商错误，请报告此问题）`;
  }
  const advice = ERROR_ADVICE[error.kind] ?? '稍后重试';
  const retryable = error.retryable ? '可重试' : '不可重试';
  return `${error.kind}：${error.message}（${retryable}，${advice}）`;
}

/** 把 TurnResult 收尾成一到两行 stderr 摘要。 */
function renderClosingLines(result: TurnResult): string {
  const usage = result.usage;
  const parts = [
    `输入 ${usage.inputTokens ?? '?'} token`,
    `输出 ${usage.outputTokens ?? '?'} token`,
  ];
  if (usage.cacheReadTokens !== undefined) {
    parts.push(`缓存读 ${usage.cacheReadTokens} token`);
  }
  if (usage.cacheWriteTokens !== undefined) {
    parts.push(`缓存写 ${usage.cacheWriteTokens} token`);
  }

  const lines = [`\n── 用量：${parts.join(' · ')}`];
  if (result.termination === 'error') {
    lines.push(`── 运行出错：${renderErrorDiagnostics(result.error)}`);
  } else if (result.termination === 'halted') {
    lines.push(`── 已终止：达到轮次/预算上限`);
  } else if (result.termination === 'interrupted') {
    const reason =
      typeof result.interruptedReason === 'string' &&
      result.interruptedReason.length > 0
        ? `（${result.interruptedReason}）`
        : '';
    lines.push(`── 已中断${reason}`);
  }
  return lines.join('\n');
}

export async function runHeadless(
  options: HeadlessOptions,
): Promise<HeadlessResult> {
  const write =
    options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const writeError =
    options.writeError ?? ((chunk: string) => process.stderr.write(chunk));
  const envelopes: Envelope[] = [];
  const tools = options.tools ?? defaultReadonlyTools();

  const result = await runAgentTurnStreaming(
    {
      provider: options.provider,
      system: options.system ?? buildSystemPrompt({ tools }),
      messages: [{ role: 'user', content: options.prompt }],
      options: {
        maxTurns: options.maxTurns ?? 10,
        abortSignal: options.abortSignal,
        retry: options.retry,
      },
      tools,
    },
    (envelope) => {
      envelopes.push(envelope);
      if (envelope.type === 'text_delta') {
        write(envelope.data.delta);
      }
    },
  );

  writeError(renderClosingLines(result));

  return { result, envelopes };
}
