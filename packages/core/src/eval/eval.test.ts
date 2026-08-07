import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import type { CompactOptions } from '../context/compact';
import { createSummaryState, merge } from '../context/summary';
import type { ProviderCapabilities } from '../provider/capabilities';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
} from '../provider/types';
import { runAgentTurn } from '../runtime/loop';
import type { RuntimeEvent } from '../runtime/loop';
import { copyFixture } from './fixtures';
import { runBunTest } from './judges';
import { formatSuiteReport, G090_THRESHOLDS } from './report';
import { runEval, runSuite } from './runner';
import { findTask, TASKS } from './tasks';

// ---------------------------------------------------------------------------
// 离线 stub 供应商：完全本地、不访问外网。按调用顺序重放事件轮次；
// 用尽后重放最后一轮（与 runtime.test.ts 的 StubProvider 同一思路）。
// 捕获每次请求的 messages（长任务压缩用例断言「投影请求保留目标」）。
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

class StubProvider implements ModelProvider {
  readonly id = 'stub';
  readonly modelId = 'stub-model';
  readonly capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES;
  /** 每次请求发给模型的 messages（压缩投影后的真实请求，供断言）。 */
  readonly seenMessages: ModelMessage[][] = [];
  private callCount = 0;

  constructor(private readonly rounds: StreamEvent[][]) {}

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    this.seenMessages.push(input.messages);
    const round = this.rounds[Math.min(this.callCount, this.rounds.length - 1)];
    this.callCount += 1;
    for (const event of round) yield event;
  }
}

/** 纯文本收尾轮：把 text 逐字符产出为 text_delta，再 usage + finish。 */
function textRound(text: string): StreamEvent[] {
  return [
    ...Array.from(text).map(
      (char) => ({ type: 'text_delta', delta: char }) as const,
    ),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as const,
    { type: 'finish', reason: 'stop' } as const,
  ];
}

// ---------------------------------------------------------------------------
// 长任务压缩用例的构造积木（T-090）
// ---------------------------------------------------------------------------

/**
 * 构造一个含 `turns` 个用户轮的线程（每轮 user + assistant 各一条），
 * 末条 user 消息是当前输入。40 轮 → 41 条 user 消息，驱动 loop 的压缩折叠
 * （splitThreadIntoTurns 按 user 消息分轮，见 context/compact.ts）。
 */
function buildLongThread(turns: number): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let i = 1; i <= turns; i += 1) {
    messages.push({
      role: 'user',
      content: `步骤 ${i}：读取 src/mathlib.ts，确认 add / subtract / multiply / divide / modulo 尚未实现。`,
    });
    messages.push({
      role: 'assistant',
      content: `已执行步骤 ${i}。`,
    });
  }
  messages.push({
    role: 'user',
    content:
      '现在请实现 mathlib 五个函数并运行 tests/final.test.ts 验证全部通过。',
  });
  return messages;
}

/** long-mathlib 的离线压缩配置：小阈值必触发、短迟滞窗口多次触发。 */
const LONG_COMPACT: CompactOptions = {
  keepTurns: 3,
  thresholdTokens: 1,
  minTurnsBetweenCompactions: 2,
  generateDelta: async () => ({
    goal: '实现 mathlib 五个函数 add/subtract/multiply/divide/modulo',
    todo: [
      {
        id: 'mathlib',
        text: '实现 add/subtract/multiply/divide/modulo 并跑测试',
      },
    ],
    findings: [{ id: 'f', text: '五个函数当前抛「未实现」' }],
  }),
};

/** longtask 的正确实现（stub 用 write 工具一次性写入）。 */
const MATHLIB_IMPL = `/**
 * 数学函数库（长任务评测 fixture）。
 */
export function add(a: number, b: number): number {
  return a + b;
}
export function subtract(a: number, b: number): number {
  return a - b;
}
export function multiply(a: number, b: number): number {
  return a * b;
}
export function divide(a: number, b: number): number {
  return a / b;
}
export function modulo(a: number, b: number): number {
  return a % b;
}
`;

/**
 * 长任务 stub 轮次：8 次 read 探索 + 1 次 write 实现 + 文本收尾。
 * 10 个模型请求、多轮之间触发至少两次压缩（迟滞窗口 2）。
 */
function buildLongRounds(): StreamEvent[][] {
  const rounds: StreamEvent[][] = [];
  for (let i = 1; i <= 8; i += 1) {
    rounds.push([
      {
        type: 'tool_use',
        id: `r${i}`,
        name: 'read',
        input: { path: 'src/mathlib.ts' },
      },
      { type: 'finish', reason: 'tool_use' },
    ]);
  }
  rounds.push([
    {
      type: 'tool_use',
      id: 'w1',
      name: 'write',
      input: {
        path: 'src/mathlib.ts',
        content: MATHLIB_IMPL,
        overwrite: true,
      },
    },
    { type: 'finish', reason: 'tool_use' },
  ]);
  rounds.push(textRound('已实现并验证。'));
  return rounds;
}

// ---------------------------------------------------------------------------

describe('评测集扩充（T-090）', () => {
  test('评测集共 24 个任务，覆盖 fix / feature / refactor / read 四类 + 1 个长任务', () => {
    expect(TASKS).toHaveLength(24);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(24);
    expect(TASKS.filter((t) => t.kind === 'fix')).toHaveLength(9);
    expect(TASKS.filter((t) => t.kind === 'feature')).toHaveLength(7);
    expect(TASKS.filter((t) => t.kind === 'refactor')).toHaveLength(3);
    expect(TASKS.filter((t) => t.kind === 'read')).toHaveLength(5);
    // 恰好一个长任务压缩用例（40+ 轮、触发压缩、压缩后延续率主要来源）
    const longTasks = TASKS.filter((t) => t.long === true);
    expect(longTasks).toHaveLength(1);
    expect(longTasks[0].maxTurns).toBeGreaterThanOrEqual(44);
    expect(longTasks[0].compact).toBeDefined();
    for (const task of TASKS) {
      expect(task.id.length).toBeGreaterThan(0);
      expect(task.prompt.length).toBeGreaterThan(0);
      expect(typeof task.judge).toBe('function');
      expect(['fix', 'feature', 'refactor', 'read']).toContain(task.kind);
    }
  });

  test('basic fixture 可复制，新增 bug 测试在全新副本上失败、回归测试通过', async () => {
    const dir = await copyFixture('basic');
    try {
      for (const rel of [
        'src/math.ts',
        'src/format.ts',
        'src/string.ts',
        'src/queue.ts',
        'src/array.ts',
        'tests/mean.test.ts',
        'tests/fib.test.ts',
        'tests/camel.test.ts',
        'tests/queue.test.ts',
        'tests/clamp.test.ts',
        'tests/gcd.test.ts',
        'tests/snake.test.ts',
        'tests/capitalize.test.ts',
        'tests/chunk.test.ts',
        'tests/regression.test.ts',
      ]) {
        expect(existsSync(join(dir, rel)), `副本缺少 ${rel}`).toBe(true);
      }
      // 有 bug 的测试文件在全新副本上确实失败（证明 bug 真实存在、可自动判定）
      for (const testPath of [
        'tests/mean.test.ts',
        'tests/fib.test.ts',
        'tests/clamp.test.ts',
        'tests/gcd.test.ts',
        'tests/snake.test.ts',
        'tests/capitalize.test.ts',
        'tests/chunk.test.ts',
      ]) {
        expect(
          (await runBunTest(dir, testPath)).pass,
          `${testPath} 应带 bug 失败`,
        ).toBe(false);
      }
      // 回归基线（正确实现）必须通过
      expect((await runBunTest(dir, 'tests/regression.test.ts')).pass).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refactor fixture 可复制：回归基线通过（行为可自动判定）', async () => {
    const dir = await copyFixture('refactor');
    try {
      for (const rel of [
        'src/shipping.ts',
        'src/orders.ts',
        'src/pricing.ts',
        'tests/regression.test.ts',
      ]) {
        expect(existsSync(join(dir, rel)), `副本缺少 ${rel}`).toBe(true);
      }
      expect((await runBunTest(dir, 'tests/regression.test.ts')).pass).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('longtask fixture 可复制：final 测试在未实现时失败', async () => {
    const dir = await copyFixture('longtask');
    try {
      for (const rel of ['src/mathlib.ts', 'tests/final.test.ts']) {
        expect(existsSync(join(dir, rel)), `副本缺少 ${rel}`).toBe(true);
      }
      // 五个函数抛「未实现」，最终测试必须红（证明任务真实、可自动判定）
      expect((await runBunTest(dir, 'tests/final.test.ts')).pass).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 新任务 judge 手工断言（T-035 同款离线验证方式：不跑模型，直接断言 judge）
  // -------------------------------------------------------------------------

  test('fix-clamp：未修复 fail / 修复后 pass', async () => {
    const task = findTask('fix-clamp');
    const dir = await copyFixture('basic');
    try {
      expect((await task.judge({ dir, text: '', task })).pass).toBe(false);
      const mathPath = join(dir, 'src', 'math.ts');
      const source = readFileSync(mathPath, 'utf8');
      writeFileSync(
        mathPath,
        source.replace(
          'if (value > max) return value;',
          'if (value > max) return max;',
        ),
        'utf8',
      );
      expect((await task.judge({ dir, text: '', task })).pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fix-gcd：未修复 fail / 修复后 pass', async () => {
    const task = findTask('fix-gcd');
    const dir = await copyFixture('basic');
    try {
      expect((await task.judge({ dir, text: '', task })).pass).toBe(false);
      const mathPath = join(dir, 'src', 'math.ts');
      const source = readFileSync(mathPath, 'utf8');
      writeFileSync(
        mathPath,
        source.replace('a = r;', 'a = b;').replace('b = a;', 'b = r;'),
        'utf8',
      );
      expect((await task.judge({ dir, text: '', task })).pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fix-snake-to-camel：未修复 fail / 修复后 pass', async () => {
    const task = findTask('fix-snake-to-camel');
    const dir = await copyFixture('basic');
    try {
      expect((await task.judge({ dir, text: '', task })).pass).toBe(false);
      const formatPath = join(dir, 'src', 'format.ts');
      const source = readFileSync(formatPath, 'utf8');
      writeFileSync(
        formatPath,
        source.replace(
          "return input.replace(/_([a-z])/g, '_$1');",
          'return input.replace(/_([a-z])/g, (_, c) => c.toUpperCase());',
        ),
        'utf8',
      );
      expect((await task.judge({ dir, text: '', task })).pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fix-capitalize：未修复 fail / 修复后 pass', async () => {
    const task = findTask('fix-capitalize');
    const dir = await copyFixture('basic');
    try {
      expect((await task.judge({ dir, text: '', task })).pass).toBe(false);
      const stringPath = join(dir, 'src', 'string.ts');
      const source = readFileSync(stringPath, 'utf8');
      writeFileSync(
        stringPath,
        source.replace(
          'return input.toUpperCase();',
          'return input.length === 0 ? input : input[0].toUpperCase() + input.slice(1);',
        ),
        'utf8',
      );
      expect((await task.judge({ dir, text: '', task })).pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fix-chunk：未修复 fail / 修复后 pass', async () => {
    const task = findTask('fix-chunk');
    const dir = await copyFixture('basic');
    try {
      expect((await task.judge({ dir, text: '', task })).pass).toBe(false);
      const arrayPath = join(dir, 'src', 'array.ts');
      const source = readFileSync(arrayPath, 'utf8');
      writeFileSync(
        arrayPath,
        source.replace('i + chunkSize <= items.length', 'i < items.length'),
        'utf8',
      );
      expect((await task.judge({ dir, text: '', task })).pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('feature-title-case：未实现 fail / 实现后 pass', async () => {
    const task = findTask('feature-title-case');
    const dir = await copyFixture('basic');
    try {
      expect((await task.judge({ dir, text: '', task })).pass).toBe(false);
      const formatPath = join(dir, 'src', 'format.ts');
      const implementation = `\nexport function titleCase(input: string): string {\n  return input\n    .split(' ')\n    .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1).toLowerCase()))\n    .join(' ');\n}\n`;
      writeFileSync(
        formatPath,
        readFileSync(formatPath, 'utf8') + implementation,
        'utf8',
      );
      expect((await task.judge({ dir, text: '', task })).pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refactor-shipping-tiers：未重构 fail（行为不变但重复仍在）/ 重构后 pass', async () => {
    const task = findTask('refactor-shipping-tiers');
    const dir = await copyFixture('refactor');
    try {
      // 未重构：回归基线通过（行为不变）但内联档位分支仍重复 → judge fail
      const unrefactored = await task.judge({ dir, text: '', task });
      expect(unrefactored.pass).toBe(false);
      expect(unrefactored.reason).toContain('行为不变');

      // 重构：抽取 tierCost 共享函数，行为不变
      const refactored = `/** 运费模块（已重构：档位定价抽取为 tierCost）。 */
export function standardCost(weightKg: number): number {
  return tierCost(weightKg, 10, 20, 3);
}
export function expressCost(weightKg: number): number {
  return tierCost(weightKg, 25, 40, 5);
}
function tierCost(weightKg: number, base1: number, base2: number, rate: number): number {
  if (weightKg <= 1) return base1;
  if (weightKg <= 5) return base2;
  return base2 + (weightKg - 5) * rate;
}
export function quote(weightKg: number, express: boolean): number {
  return express ? expressCost(weightKg) : standardCost(weightKg);
}
`;
      writeFileSync(join(dir, 'src', 'shipping.ts'), refactored, 'utf8');
      expect((await task.judge({ dir, text: '', task })).pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refactor-orders-pick：未重构 fail / 重构后 pass', async () => {
    const task = findTask('refactor-orders-pick');
    const dir = await copyFixture('refactor');
    try {
      expect((await task.judge({ dir, text: '', task })).pass).toBe(false);

      const refactored = `/** 订单模块（已重构：字段挑选抽取为 pickOrderFields）。 */
export interface Order {
  readonly id: string;
  readonly total: number;
  readonly status: string;
  readonly reviewer?: string;
}
function pickOrderFields(
  order: Order,
): { readonly id: string; readonly total: number; readonly status: string } {
  return { id: order.id, total: order.total, status: order.status };
}
export function summary(
  order: Order,
): { readonly id: string; readonly total: number; readonly status: string } {
  return pickOrderFields(order);
}
export function audit(order: Order): Order {
  return { ...pickOrderFields(order), reviewer: order.reviewer };
}
`;
      writeFileSync(join(dir, 'src', 'orders.ts'), refactored, 'utf8');
      expect((await task.judge({ dir, text: '', task })).pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refactor-pricing-round：未重构 fail / 重构后 pass', async () => {
    const task = findTask('refactor-pricing-round');
    const dir = await copyFixture('refactor');
    try {
      expect((await task.judge({ dir, text: '', task })).pass).toBe(false);

      const refactored = `/** 价格模块（已重构：四舍五入抽取为 roundToCents）。 */
function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}
export function roundPrice(amount: number): number {
  return roundToCents(amount);
}
export function discountPrice(price: number, percent: number): number {
  return roundToCents(price * (1 - percent / 100));
}
export function taxPrice(price: number, rate: number): number {
  return roundToCents(price * (1 + rate / 100));
}
`;
      writeFileSync(join(dir, 'src', 'pricing.ts'), refactored, 'utf8');
      expect((await task.judge({ dir, text: '', task })).pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 长任务压缩用例（T-090）：40+ 轮 + 触发压缩，judge 压缩后仍通过
  // -------------------------------------------------------------------------

  test('长任务压缩：40+ 轮线程触发压缩，投影请求保留初始需求（目标在摘要块）', async () => {
    const thread = buildLongThread(40);
    const provider = new StubProvider([textRound('完成')]);
    const events: RuntimeEvent[] = [];
    const state = merge(createSummaryState(), {
      goal: '实现 mathlib 五个函数',
    });
    const result = await runAgentTurn(
      {
        provider,
        messages: thread,
        summaryState: state,
        compact: {
          keepTurns: 3,
          thresholdTokens: 1,
          generateDelta: async () => ({
            findings: [{ id: 'f', text: '已折叠早期轮次' }],
          }),
        },
        options: { maxTurns: 1 },
      },
      (event) => {
        events.push(event);
      },
    );

    // 压缩触发：compaction 事件出现、摘要状态演进
    const compactionEvents = events.filter((e) => e.type === 'compaction');
    expect(compactionEvents.length).toBeGreaterThanOrEqual(1);
    expect(result.summaryState).toBeDefined();
    expect(result.summaryState!.rev).toBe(state.rev + 1);

    // 发给模型的投影请求 = 摘要块 + 近 3 轮原文：目标保留、早期轮次折叠
    const seen = provider.seenMessages[0];
    expect(seen[0].role).toBe('system');
    const seenText = seen
      .map((m) =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      )
      .join('\n');
    expect(seenText).toContain('实现 mathlib 五个函数'); // 初始需求在摘要块
    expect(seenText).toContain('步骤 40：'); // 近几轮原文保留
    expect(seenText).not.toContain('步骤 1：'); // 早期轮次已折叠
  });

  test('runEval 长任务：40+ 轮线程 + 多次压缩，judge 压缩后仍通过', async () => {
    const task = findTask('long-mathlib');
    const thread = buildLongThread(40);
    expect(thread.filter((m) => m.role === 'user')).toHaveLength(41);

    const result = await runEval({
      provider: new StubProvider(buildLongRounds()),
      task,
      messages: thread,
      compact: LONG_COMPACT,
      maxTurns: 44,
    });

    // 多次压缩（迟滞窗口 2 → 第 1/3/5/7/9 轮触发，共 5 次）
    expect(result.metrics.compactions).toBeGreaterThanOrEqual(2);
    // 压缩后 judge 仍通过：任务延续（压缩后任务延续率的观测对象）
    expect(result.pass).toBe(true);
    expect(result.turns).toBe(10);
    // 工具：8 read + 1 write 全部成功
    expect(result.metrics.toolSuccessRate).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 五项度量聚合（T-091）：runSuite
  // -------------------------------------------------------------------------

  test('runSuite 聚合五项度量（完成率/工具/编辑/压缩延续率/token 基线）', async () => {
    const fixDir = await copyFixture('basic');
    try {
      const longTask = findTask('long-mathlib');
      const readTasks = [
        findTask('read-average-empty'),
        findTask('read-is-prime'),
      ];
      const answers: Record<string, string> = {
        'read-average-empty': 'average 对空数组返回 NaN。',
        'read-is-prime': 'isPrime(1) 返回 false。',
      };
      // fix-average 的 stub：read + edit 命中 + edit 未命中 + 文本收尾
      const fixRounds: StreamEvent[][] = [
        [
          {
            type: 'tool_use',
            id: 'r1',
            name: 'read',
            input: { path: 'src/math.ts' },
          },
          {
            type: 'tool_use',
            id: 'e1',
            name: 'edit',
            input: {
              path: 'src/math.ts',
              old_string: 'values.length - 1',
              new_string: 'values.length',
            },
          },
          {
            type: 'tool_use',
            id: 'e2',
            name: 'edit',
            input: {
              path: 'src/math.ts',
              old_string: '完全不存在的内容',
              new_string: 'x',
            },
          },
          { type: 'finish', reason: 'tool_use' },
        ],
        textRound('已修复'),
      ];

      const suite = await runSuite({
        tasks: [longTask, findTask('fix-average'), ...readTasks],
        provider: (task) => {
          if (task.id === 'long-mathlib') {
            return new StubProvider(buildLongRounds());
          }
          if (task.id === 'fix-average') return new StubProvider(fixRounds);
          return new StubProvider([textRound(answers[task.id] ?? '不知道')]);
        },
        runForTask: (task) => {
          if (task.id === 'long-mathlib') {
            return {
              messages: buildLongThread(40),
              compact: LONG_COMPACT,
              maxTurns: 44,
            };
          }
          if (task.id === 'fix-average') return { cwd: fixDir, cleanup: false };
          return {};
        },
      });

      expect(suite.results).toHaveLength(4);
      // 度量一：任务完成率 4/4
      expect(suite.taskCompletionRate).toBe(1);
      // 度量二：工具成功率（long 9 成功 / fix 2 成功 1 失败 → 11/12）
      expect(suite.toolSuccessRate).toBeCloseTo(11 / 12);
      // 度量三：编辑一次命中率（fix 2 次 edit 中 1 次命中）
      expect(suite.editHitRate).toBeCloseTo(0.5);
      // 度量四：压缩后延续率（long 压缩且通过 → 1/1）
      expect(suite.compactionCandidates).toBe(1);
      expect(suite.compactionContinuations).toBe(1);
      expect(suite.compactionContinuationRate).toBe(1);
      // 度量五：token 基线（4 任务各一次 usage {input:10, output:5}）
      expect(suite.tokenBaseline.totalInputTokens).toBe(40);
      expect(suite.tokenBaseline.totalOutputTokens).toBe(20);
      expect(suite.tokenBaseline.totalTokens).toBe(60);
      expect(suite.tokenBaseline.avgTokensPerTask).toBe(15);

      // 可读报告：五项指标与逐任务明细齐全
      const report = formatSuiteReport(suite);
      expect(report).toContain('任务完成率');
      expect(report).toContain('工具成功率');
      expect(report).toContain('编辑一次命中率');
      expect(report).toContain('压缩后延续率');
      expect(report).toContain('token 基线');
      expect(report).toContain('逐任务明细');
      expect(report).toContain('long-mathlib');
      expect(report).toContain(
        `${(G090_THRESHOLDS.taskCompletionRate * 100).toFixed(1)}%`,
      );
    } finally {
      rmSync(fixDir, { recursive: true, force: true });
    }
  });

  test('runSuite：无压缩任务时压缩后延续率 undefined，完成率与工具度量照常聚合', async () => {
    const readTasks = [
      findTask('read-average-empty'),
      findTask('read-queue-peek-empty'),
      findTask('read-is-prime'),
    ];
    const answers: Record<string, string> = {
      'read-average-empty': 'average 对空数组返回 NaN。',
      'read-queue-peek-empty': 'TaskQueue.peek 在空队列时返回 undefined。',
      'read-is-prime': 'isPrime(1) 返回 false。',
    };
    const suite = await runSuite({
      tasks: readTasks,
      provider: (task) =>
        new StubProvider([textRound(answers[task.id] ?? '不知道')]),
    });
    expect(suite.results).toHaveLength(3);
    expect(suite.taskCompletionRate).toBe(1);
    expect(suite.toolSuccessRate).toBeUndefined(); // read 任务不调工具
    expect(suite.editHitRate).toBeUndefined();
    expect(suite.compactionCandidates).toBe(0);
    expect(suite.compactionContinuationRate).toBeUndefined();
    expect(suite.tokenBaseline.avgTokensPerTask).toBe(15);
  });

  test('runSuite：压缩但未通过的任务不计入延续（延续率 0）', async () => {
    const task = findTask('long-mathlib');
    // stub 只读不写：压缩发生但 judge 失败（final 测试仍红）
    const readOnlyRounds: StreamEvent[][] = Array.from(
      { length: 8 },
      (_, i): StreamEvent[] => [
        {
          type: 'tool_use',
          id: `r${i + 1}`,
          name: 'read',
          input: { path: 'src/mathlib.ts' },
        },
        { type: 'finish', reason: 'tool_use' },
      ],
    );
    readOnlyRounds.push(textRound('我尝试了，但没能实现。'));
    const suite = await runSuite({
      tasks: [task],
      provider: () => new StubProvider(readOnlyRounds),
      runForTask: () => ({
        messages: buildLongThread(40),
        compact: LONG_COMPACT,
        maxTurns: 44,
      }),
    });
    expect(suite.results).toHaveLength(1);
    expect(suite.results[0].pass).toBe(false);
    expect(suite.results[0].metrics.compactions).toBeGreaterThanOrEqual(2);
    expect(suite.compactionCandidates).toBe(1);
    expect(suite.compactionContinuations).toBe(0);
    expect(suite.compactionContinuationRate).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 既有用例（T-035）保留：read 判定 / fix 未修复 / 度量采集
  // -------------------------------------------------------------------------

  test('runEval：read 任务在 stub 驱动下判定正确（正确回答 pass / 错误回答 fail）', async () => {
    const cases: ReadonlyArray<{
      id: string;
      answer: string;
      wrong: string;
    }> = [
      {
        id: 'read-average-empty',
        answer: 'average 对空数组返回 NaN。',
        wrong: '我不知道。',
      },
      {
        id: 'read-fibonacci-zero',
        answer: 'fibonacci(0) 返回 1。',
        wrong: 'fibonacci(0) 返回 0。',
      },
      {
        id: 'read-queue-peek-empty',
        answer: 'TaskQueue.peek 在空队列时返回 undefined。',
        wrong: 'TaskQueue.peek 返回队头元素。',
      },
      {
        id: 'read-is-prime',
        answer: 'isPrime(1) 返回 false。',
        wrong: 'isPrime(1) 返回 true。',
      },
      {
        id: 'read-gcd-algorithm',
        answer: 'gcd 使用欧几里得算法。',
        wrong: '我不知道。',
      },
    ];
    for (const item of cases) {
      const task = findTask(item.id);
      const passRun = await runEval({
        provider: new StubProvider([textRound(item.answer)]),
        task,
      });
      expect(passRun.pass, `${item.id} 正确回答应 pass`).toBe(true);

      const failRun = await runEval({
        provider: new StubProvider([textRound(item.wrong)]),
        task,
      });
      expect(failRun.pass, `${item.id} 错误回答应 fail`).toBe(false);
    }
  });

  test('runEval：fix 任务在 stub 未修复时判 fail（真实模型修复闭环留 0.9.0）', async () => {
    const task = findTask('fix-average');
    const result = await runEval({
      provider: new StubProvider([textRound('完成')]),
      task,
    });
    expect(result.pass).toBe(false);
    expect(result.metrics.toolCalls).toBe(0);
    expect(result.metrics.compactions).toBe(0);
    expect(result.termination).toBe('end_turn');
  });

  test('runEval 采集工具调用成功率与编辑一次命中率度量', async () => {
    const task = findTask('fix-average');
    const dir = await copyFixture('basic');
    try {
      // stub 轮次：read → edit（命中）→ edit（未命中）→ 纯文本收尾
      const rounds: StreamEvent[][] = [
        [
          {
            type: 'tool_use',
            id: 'r1',
            name: 'read',
            input: { path: 'src/math.ts' },
          },
          {
            type: 'tool_use',
            id: 'e1',
            name: 'edit',
            input: {
              path: 'src/math.ts',
              old_string: 'values.length - 1',
              new_string: 'values.length',
            },
          },
          {
            type: 'tool_use',
            id: 'e2',
            name: 'edit',
            input: {
              path: 'src/math.ts',
              old_string: '完全不存在的内容',
              new_string: 'x',
            },
          },
          { type: 'finish', reason: 'tool_use' },
        ],
        textRound('已修复'),
      ];
      const result = await runEval({
        provider: new StubProvider(rounds),
        task,
        cwd: dir,
        cleanup: false,
      });
      // read 与第一个 edit 成功，第二个 edit（无匹配）失败
      expect(result.metrics.toolCalls).toBe(3);
      expect(result.metrics.toolSuccesses).toBe(2);
      expect(result.metrics.toolFailures).toBe(1);
      expect(result.metrics.toolSuccessRate).toBeCloseTo(2 / 3);
      expect(result.metrics.editCalls).toBe(2);
      expect(result.metrics.editHits).toBe(1);
      expect(result.metrics.editHitRate).toBeCloseTo(0.5);
      expect(result.turns).toBe(2);
      // 副本上修复已真实生效 → 判定通过
      expect(result.pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
