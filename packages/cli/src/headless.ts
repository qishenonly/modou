import {
  runAgentTurnStreaming,
  type Envelope,
  type ModelProvider,
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
  /** 系统指令（可选；0.1.0 默认不注入）。 */
  readonly system?: string;
  /** 轮次上限（默认 10）。 */
  readonly maxTurns?: number;
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
    lines.push(`── 运行出错：${result.error?.message ?? '未知错误'}`);
  } else if (result.termination === 'halted') {
    lines.push(`── 已终止：达到轮次/预算上限`);
  } else if (result.termination === 'interrupted') {
    lines.push(`── 已中断`);
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

  const result = await runAgentTurnStreaming(
    {
      provider: options.provider,
      system: options.system,
      messages: [{ role: 'user', content: options.prompt }],
      options: { maxTurns: options.maxTurns ?? 10 },
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
