import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderCapabilities } from '../provider/capabilities';
import type { ModelProvider, StreamEvent } from '../provider/types';
import { copyFixture } from './fixtures';
import { runBunTest } from './judges';
import { runEval, runSuite } from './runner';
import { findTask, TASKS } from './tasks';

// ---------------------------------------------------------------------------
// 离线 stub 供应商：完全本地、不访问外网。按调用顺序重放事件轮次；
// 用尽后重放最后一轮（与 runtime.test.ts 的 StubProvider 同一思路）。
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
  private callCount = 0;

  constructor(private readonly rounds: StreamEvent[][]) {}

  // 接口方法参数由调用方注入，stub 不需要读它：少声明参数仍满足接口契约
  // （TS 对方法的参数 bivariance 允许实现方省略入参），运行时多余实参被忽略。
  async *streamChat(): AsyncIterable<StreamEvent> {
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

describe('评测集骨架（T-035）', () => {
  test('首批任务共 10 个，覆盖 fix / feature / read 三类', () => {
    expect(TASKS).toHaveLength(10);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(10);
    expect(TASKS.filter((t) => t.kind === 'fix')).toHaveLength(4);
    expect(TASKS.filter((t) => t.kind === 'feature')).toHaveLength(3);
    expect(TASKS.filter((t) => t.kind === 'read')).toHaveLength(3);
    for (const task of TASKS) {
      expect(task.id.length).toBeGreaterThan(0);
      expect(task.prompt.length).toBeGreaterThan(0);
      expect(typeof task.judge).toBe('function');
    }
  });

  test('fixture 可复制，副本上 bug 测试失败、回归测试通过', async () => {
    const dir = await copyFixture('basic');
    try {
      for (const rel of [
        'src/math.ts',
        'src/format.ts',
        'src/string.ts',
        'src/queue.ts',
        'tests/mean.test.ts',
        'tests/fib.test.ts',
        'tests/camel.test.ts',
        'tests/queue.test.ts',
        'tests/regression.test.ts',
      ]) {
        expect(existsSync(join(dir, rel)), `副本缺少 ${rel}`).toBe(true);
      }
      // 有 bug 的测试文件在全新副本上确实失败（证明 bug 真实存在、可自动判定）
      expect((await runBunTest(dir, 'tests/mean.test.ts')).pass).toBe(false);
      expect((await runBunTest(dir, 'tests/fib.test.ts')).pass).toBe(false);
      // 回归基线（正确实现）必须通过
      expect((await runBunTest(dir, 'tests/regression.test.ts')).pass).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fix-average：judge 手工断言（未修复 fail / 修复后 pass），且不污染源 fixture', async () => {
    const task = findTask('fix-average');
    const dir = await copyFixture('basic');
    try {
      // 未修复：含 bug 的测试失败 → judge fail
      expect((await task.judge({ dir, text: '', task })).pass).toBe(false);

      // 应用修复：除数 length-1 → length
      const mathPath = join(dir, 'src', 'math.ts');
      const source = readFileSync(mathPath, 'utf8');
      writeFileSync(
        mathPath,
        source.replace('values.length - 1', 'values.length'),
        'utf8',
      );
      expect((await task.judge({ dir, text: '', task })).pass).toBe(true);

      // 仓库源 fixture 未被副本上的修改污染（仍保留 bug）
      const fixtureMath = readFileSync(
        join(import.meta.dir, 'fixtures', 'basic', 'src', 'math.ts'),
        'utf8',
      );
      expect(fixtureMath).toContain('values.length - 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('feature-format-bytes：judge 手工断言（未实现 fail / 实现后 pass）', async () => {
    const task = findTask('feature-format-bytes');
    const dir = await copyFixture('basic');
    try {
      // 未实现：grep 断言失败 → judge fail
      expect((await task.judge({ dir, text: '', task })).pass).toBe(false);

      // 在 src/format.ts 末尾追加符合任务规格的实现
      const formatPath = join(dir, 'src', 'format.ts');
      const implementation = `\nexport function formatBytes(bytes: number): string {\n  const units = ['B', 'KB', 'MB', 'GB', 'TB'];\n  let value = bytes;\n  let unit = 0;\n  while (value >= 1024 && unit < units.length - 1) {\n    value /= 1024;\n    unit += 1;\n  }\n  const formatted = unit === 0 ? String(value) : parseFloat(value.toFixed(1)).toString();\n  return \`\${formatted} \${units[unit]}\`;\n}\n`;
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

  test('runSuite 聚合任务完成率与工具成功率', async () => {
    const readTasks = TASKS.filter((t) => t.kind === 'read');
    const answers: Record<string, string> = {
      'read-average-empty': 'average 对空数组返回 NaN。',
      'read-fibonacci-zero': 'fibonacci(0) 返回 1。',
      'read-queue-peek-empty': 'TaskQueue.peek 在空队列时返回 undefined。',
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
  });
});
