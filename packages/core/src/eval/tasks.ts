import { fileContains, runBunTest, runProbeTest } from './judges';
import type { EvalTask } from './types';

/**
 * 首批 10 个评测任务（T-035），fixture = `fixtures/basic`。
 *
 * 三类覆盖：
 * - 修 bug（4）：平均、斐波那契、camelToSnake、TaskQueue——judge 运行对应测试文件，
 *   修复前红、修复后绿，自动判定无歧义；
 * - 加功能（3）：formatBytes、csvToJson、isPalindrome——judge 先 grep 断言导出存在，
 *   再跑探针测试断言行为；
 * - 读代码答问（3）：空数组的 average、fibonacci(0)、空队列的 peek——judge 对模型
 *   最终文本做关键词 / 结构断言。
 *
 * 每个任务的 judge 只依赖 `fixtures/basic` 副本 + 模型输出，可离线手工断言。
 */

/** formatBytes 探针：按任务 prompt 规定的规格精确断言。 */
const FORMAT_BYTES_PROBE = `import { describe, expect, test } from 'bun:test';
import { formatBytes } from '../src/format';

describe('formatBytes', () => {
  test('按 1024 进制格式化', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
  });
});
`;

/** csvToJson 探针：表头 + 数据行、跳空行。 */
const CSV_TO_JSON_PROBE = `import { describe, expect, test } from 'bun:test';
import { csvToJson } from '../src/format';

describe('csvToJson', () => {
  test('表头 + 数据行', () => {
    expect(csvToJson('a,b\\n1,2')).toEqual([{ a: '1', b: '2' }]);
  });
  test('跳过空行', () => {
    expect(csvToJson('a\\n1\\n\\n2')).toEqual([{ a: '1' }, { a: '2' }]);
  });
});
`;

/** isPalindrome 探针：忽略大小写与标点、基本回文、非回文。 */
const IS_PALINDROME_PROBE = `import { describe, expect, test } from 'bun:test';
import { isPalindrome } from '../src/string';

describe('isPalindrome', () => {
  test('忽略大小写与非字母数字', () => {
    expect(isPalindrome('A man, a plan, a canal: Panama')).toBe(true);
    expect(isPalindrome('racecar')).toBe(true);
    expect(isPalindrome('hello')).toBe(false);
  });
});
`;

/** 首批评测任务清单（顺序稳定：修 bug → 加功能 → 读代码答问）。 */
export const TASKS: readonly EvalTask[] = [
  // ---- 修 bug（4）：judge = 运行对应测试文件，必须全绿 ----
  {
    id: 'fix-average',
    kind: 'fix',
    title: '修复 average 函数的除数 bug',
    fixture: 'basic',
    prompt:
      '在 src/math.ts 中定位并修复 average 函数的 bug，使 `bun test tests/mean.test.ts` 全部通过。修复后自行运行该测试验证。不要改动其他文件。',
    judge: (ctx) => runBunTest(ctx.dir, 'tests/mean.test.ts'),
  },
  {
    id: 'fix-fibonacci',
    kind: 'fix',
    title: '修复 fibonacci 的基准条件 bug',
    fixture: 'basic',
    prompt:
      '在 src/math.ts 中定位并修复 fibonacci 函数的 bug，使 `bun test tests/fib.test.ts` 全部通过。修复后自行运行该测试验证。不要改动其他文件。',
    judge: (ctx) => runBunTest(ctx.dir, 'tests/fib.test.ts'),
  },
  {
    id: 'fix-camel-to-snake',
    kind: 'fix',
    title: '修复 camelToSnake 的大小写 bug',
    fixture: 'basic',
    prompt:
      '在 src/format.ts 中定位并修复 camelToSnake 函数的 bug，使 `bun test tests/camel.test.ts` 全部通过。修复后自行运行该测试验证。不要改动其他文件。',
    judge: (ctx) => runBunTest(ctx.dir, 'tests/camel.test.ts'),
  },
  {
    id: 'fix-task-queue',
    kind: 'fix',
    title: '修复 TaskQueue.dequeue 的 FIFO 语义 bug',
    fixture: 'basic',
    prompt:
      '在 src/queue.ts 中定位并修复 TaskQueue.dequeue 方法的 bug，使 `bun test tests/queue.test.ts` 全部通过。修复后自行运行该测试验证。不要改动其他文件。',
    judge: (ctx) => runBunTest(ctx.dir, 'tests/queue.test.ts'),
  },

  // ---- 加功能（3）：judge = grep 断言导出 + 探针测试断言行为 ----
  {
    id: 'feature-format-bytes',
    kind: 'feature',
    title: '新增 formatBytes 字节格式化函数',
    fixture: 'basic',
    prompt:
      '在 src/format.ts 中新增并导出 `formatBytes(bytes: number): string`：按 1024 进制把字节数格式化为人可读字符串——`0 → "0 B"`、`1024 → "1 KB"`、`1536 → "1.5 KB"`、`1048576 → "1 MB"`。实现后自行运行测试验证。不要改动其他文件。',
    judge: async (ctx) => {
      const declared = await fileContains(
        ctx.dir,
        'src/format.ts',
        /export\s+function\s+formatBytes\s*\(/,
      );
      if (!declared.pass) return declared;
      return runProbeTest(ctx.dir, 'feature-format-bytes', FORMAT_BYTES_PROBE);
    },
  },
  {
    id: 'feature-csv-to-json',
    kind: 'feature',
    title: '新增 csvToJson CSV 解析函数',
    fixture: 'basic',
    prompt:
      '在 src/format.ts 中新增并导出 `csvToJson(csv: string): Array<Record<string, string>>`：把 CSV 文本解析为对象数组，首行为表头，后续每行一个对象（如 `"a,b\\n1,2"` → `[{ a: "1", b: "2" }]`），跳过空行。实现后自行运行测试验证。不要改动其他文件。',
    judge: async (ctx) => {
      const declared = await fileContains(
        ctx.dir,
        'src/format.ts',
        /export\s+function\s+csvToJson\s*\(/,
      );
      if (!declared.pass) return declared;
      return runProbeTest(ctx.dir, 'feature-csv-to-json', CSV_TO_JSON_PROBE);
    },
  },
  {
    id: 'feature-is-palindrome',
    kind: 'feature',
    title: '新增 isPalindrome 回文判断函数',
    fixture: 'basic',
    prompt:
      '在 src/string.ts 中新增并导出 `isPalindrome(input: string): boolean`：忽略大小写与非字母数字字符判断回文（如 `"A man, a plan, a canal: Panama"` → true、`"racecar"` → true、`"hello"` → false）。实现后自行运行测试验证。不要改动其他文件。',
    judge: async (ctx) => {
      const declared = await fileContains(
        ctx.dir,
        'src/string.ts',
        /export\s+function\s+isPalindrome\s*\(/,
      );
      if (!declared.pass) return declared;
      return runProbeTest(
        ctx.dir,
        'feature-is-palindrome',
        IS_PALINDROME_PROBE,
      );
    },
  },

  // ---- 读代码答问（3）：judge = 关键词 / 结构断言模型文本输出 ----
  {
    id: 'read-average-empty',
    kind: 'read',
    title: 'average 对空数组的行为',
    fixture: 'basic',
    prompt:
      '请阅读 src/math.ts 中的 average 函数，回答：它对空数组会返回什么？只回答结论。',
    judge: (ctx) =>
      /NaN/.test(ctx.text)
        ? { pass: true, reason: '答出空数组返回 NaN' }
        : {
            pass: false,
            reason: `文本未提及 NaN：${ctx.text.slice(0, 200)}`,
          },
  },
  {
    id: 'read-fibonacci-zero',
    kind: 'read',
    title: 'fibonacci(0) 的返回值',
    fixture: 'basic',
    prompt:
      '请阅读 src/math.ts 中的 fibonacci 函数，回答：fibonacci(0) 返回多少？只回答结论。',
    judge: (ctx) => {
      const mentionsZero = /fibonacci\s*\(\s*0\s*\)|fib\(0\)/.test(ctx.text);
      const saysOne = /\b1\b/.test(ctx.text);
      return mentionsZero && saysOne
        ? { pass: true, reason: '答出 fibonacci(0) 返回 1' }
        : {
            pass: false,
            reason: `文本未答出「fibonacci(0) 返回 1」：${ctx.text.slice(0, 200)}`,
          };
    },
  },
  {
    id: 'read-queue-peek-empty',
    kind: 'read',
    title: 'TaskQueue.peek 在空队列时的行为',
    fixture: 'basic',
    prompt:
      '请阅读 src/queue.ts 中的 TaskQueue.peek 方法，回答：队列为空时它返回什么？只回答结论。',
    judge: (ctx) =>
      /undefined|未定义|空值/.test(ctx.text) &&
      !/空队列.*返回.*队头|队头|头元素/.test(ctx.text)
        ? { pass: true, reason: '答出 peek 空队列返回 undefined' }
        : {
            pass: false,
            reason: `文本未答出空队列行为：${ctx.text.slice(0, 200)}`,
          },
  },
];

/** 按 id 查找任务（未命中抛错，防止评测脚本拼错 id）。 */
export function findTask(id: string): EvalTask {
  const task = TASKS.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`未知评测任务：${id}`);
  return task;
}
