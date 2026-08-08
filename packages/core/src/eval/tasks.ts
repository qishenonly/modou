import {
  fileContains,
  readFixtureFile,
  runBunTest,
  runProbeTest,
} from './judges';
import { isEmptyPlan, parseStructuredPlan } from '../plan/plan';
import type { EvalTask } from './types';

/**
 * 评测集 24 个任务（T-090 扩充），覆盖四类：
 * - 修 bug（9）：average / fibonacci / camelToSnake / TaskQueue（T-035 原有）
 *   + clamp / gcd / snakeToCamel / capitalize / chunk（T-090 新增）——
 *   judge 运行对应测试文件，修复前红、修复后绿，自动判定无歧义；
 * - 加功能（6）：formatBytes / csvToJson / isPalindrome（T-035 原有）
 *   + titleCase / truncate / unique（T-090 新增）——judge 先 grep 断言导出
 *   存在，再跑探针测试断言行为；
 * - 重构（3，T-090 新增，fixture = `fixtures/refactor`）：shipping 抽取档位
 *   逻辑 / orders 抽取字段挑选 / pricing 抽取四舍五入——judge 先跑回归基线
 *   断言**行为不变**，再 grep 断言重复逻辑已抽取；
 * - 读代码答问（5）：average 空数组 / fibonacci(0) / TaskQueue.peek 空队列
 *   （T-035 原有）+ isPrime(1) / gcd 算法（T-090 新增）——judge 对模型最终
 *   文本做关键词 / 结构断言。
 *
 * 另含 1 个**长任务压缩用例**（long-mathlib，`long: true`，fixture =
 * `fixtures/longtask`）：实现 mathlib 五个函数，maxTurns 44，启用压缩配置
 * （T-070）——验证「压缩后任务延续率」：会话中途压缩后，judge 仍通过。
 *
 * 每个任务的 judge 只依赖 fixture 副本 + 模型输出，可离线手工断言。
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

/** titleCase 探针：每词首字母大写、其余小写。 */
const TITLE_CASE_PROBE = `import { describe, expect, test } from 'bun:test';
import { titleCase } from '../src/format';

describe('titleCase', () => {
  test('每词首字母大写其余小写', () => {
    expect(titleCase('hello WORLD')).toBe('Hello World');
    expect(titleCase('a b c')).toBe('A B C');
  });
  test('空字符串', () => {
    expect(titleCase('')).toBe('');
  });
});
`;

/** truncate 探针：超长截断加省略号、未超长原样返回。 */
const TRUNCATE_PROBE = `import { describe, expect, test } from 'bun:test';
import { truncate } from '../src/string';

describe('truncate', () => {
  test('超长截断并加省略号', () => {
    expect(truncate('hello', 3)).toBe('hel…');
  });
  test('未超长原样返回', () => {
    expect(truncate('hi', 3)).toBe('hi');
  });
});
`;

/** unique 探针：去重并保留首次出现顺序。 */
const UNIQUE_PROBE = `import { describe, expect, test } from 'bun:test';
import { unique } from '../src/array';

describe('unique', () => {
  test('去重并保留顺序', () => {
    expect(unique([1, 2, 1, 3])).toEqual([1, 2, 3]);
    expect(unique(['a', 'b', 'a'])).toEqual(['a', 'b']);
  });
});
`;

/**
 * 评测任务清单（顺序稳定：修 bug → 加功能 → 重构 → 读代码答问 → 长任务）。
 */
export const TASKS: readonly EvalTask[] = [
  // ---- 修 bug（9）：judge = 运行对应测试文件，必须全绿 ----
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
  {
    id: 'fix-clamp',
    kind: 'fix',
    title: '修复 clamp 的上限夹取 bug',
    fixture: 'basic',
    prompt:
      '在 src/math.ts 中定位并修复 clamp 函数的 bug，使 `bun test tests/clamp.test.ts` 全部通过。修复后自行运行该测试验证。不要改动其他文件。',
    judge: (ctx) => runBunTest(ctx.dir, 'tests/clamp.test.ts'),
  },
  {
    id: 'fix-gcd',
    kind: 'fix',
    title: '修复 gcd 的辗转相除 bug',
    fixture: 'basic',
    prompt:
      '在 src/math.ts 中定位并修复 gcd 函数的 bug，使 `bun test tests/gcd.test.ts` 全部通过。修复后自行运行该测试验证。不要改动其他文件。',
    judge: (ctx) => runBunTest(ctx.dir, 'tests/gcd.test.ts'),
  },
  {
    id: 'fix-snake-to-camel',
    kind: 'fix',
    title: '修复 snakeToCamel 的下划线 bug',
    fixture: 'basic',
    prompt:
      '在 src/format.ts 中定位并修复 snakeToCamel 函数的 bug，使 `bun test tests/snake.test.ts` 全部通过。修复后自行运行该测试验证。不要改动其他文件。',
    judge: (ctx) => runBunTest(ctx.dir, 'tests/snake.test.ts'),
  },
  {
    id: 'fix-capitalize',
    kind: 'fix',
    title: '修复 capitalize 的首字母大写 bug',
    fixture: 'basic',
    prompt:
      '在 src/string.ts 中定位并修复 capitalize 函数的 bug，使 `bun test tests/capitalize.test.ts` 全部通过。修复后自行运行该测试验证。不要改动其他文件。',
    judge: (ctx) => runBunTest(ctx.dir, 'tests/capitalize.test.ts'),
  },
  {
    id: 'fix-chunk',
    kind: 'fix',
    title: '修复 chunk 的余数块丢弃 bug',
    fixture: 'basic',
    prompt:
      '在 src/array.ts 中定位并修复 chunk 函数的 bug，使 `bun test tests/chunk.test.ts` 全部通过。修复后自行运行该测试验证。不要改动其他文件。',
    judge: (ctx) => runBunTest(ctx.dir, 'tests/chunk.test.ts'),
  },

  // ---- 加功能（6）：judge = grep 断言导出 + 探针测试断言行为 ----
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
  {
    id: 'feature-title-case',
    kind: 'feature',
    title: '新增 titleCase 标题大小写函数',
    fixture: 'basic',
    prompt:
      '在 src/format.ts 中新增并导出 `titleCase(input: string): string`：把每个单词首字母大写、其余字母小写（如 `"hello WORLD"` → `"Hello World"`、`"a b c"` → `"A B C"`）。实现后自行运行测试验证。不要改动其他文件。',
    judge: async (ctx) => {
      const declared = await fileContains(
        ctx.dir,
        'src/format.ts',
        /export\s+function\s+titleCase\s*\(/,
      );
      if (!declared.pass) return declared;
      return runProbeTest(ctx.dir, 'feature-title-case', TITLE_CASE_PROBE);
    },
  },
  {
    id: 'feature-truncate',
    kind: 'feature',
    title: '新增 truncate 截断函数',
    fixture: 'basic',
    prompt:
      '在 src/string.ts 中新增并导出 `truncate(text: string, maxLen: number): string`：text 长度 ≤ maxLen 时原样返回，否则截断到 maxLen 个字符并追加省略号 `…`（如 `truncate("hello", 3)` → `"hel…"`、`truncate("hi", 3)` → `"hi"`）。实现后自行运行测试验证。不要改动其他文件。',
    judge: async (ctx) => {
      const declared = await fileContains(
        ctx.dir,
        'src/string.ts',
        /export\s+function\s+truncate\s*\(/,
      );
      if (!declared.pass) return declared;
      return runProbeTest(ctx.dir, 'feature-truncate', TRUNCATE_PROBE);
    },
  },
  {
    id: 'feature-unique',
    kind: 'feature',
    title: '新增 unique 数组去重函数',
    fixture: 'basic',
    prompt:
      '在 src/array.ts 中新增并导出 `unique<T>(items: readonly T[]): T[]`：去重并保留首次出现顺序（如 `unique([1, 2, 1, 3])` → `[1, 2, 3]`）。实现后自行运行测试验证。不要改动其他文件。',
    judge: async (ctx) => {
      const declared = await fileContains(
        ctx.dir,
        'src/array.ts',
        /export\s+function\s+unique\s*\(/,
      );
      if (!declared.pass) return declared;
      return runProbeTest(ctx.dir, 'feature-unique', UNIQUE_PROBE);
    },
  },

  // ---- 重构（3，T-090 新增）：judge = 回归基线（行为不变）+ 重复逻辑已抽取 ----
  {
    id: 'refactor-shipping-tiers',
    kind: 'refactor',
    title: '重构 shipping：抽取重复的重量档位逻辑',
    fixture: 'refactor',
    prompt:
      '在 src/shipping.ts 中重构：standardCost 与 expressCost 重复了「重量档位 → 基础价 / 超重单价」的阶梯定价逻辑（weightKg <= 1 / weightKg <= 5 两档阈值各写了一遍）。请把档位定价逻辑抽取为共享函数（命名自定），两个函数复用它，对外行为必须不变——`bun test tests/regression.test.ts` 必须保持通过。重构后自行运行测试验证。不要改动测试文件与其他文件。',
    judge: async (ctx) => {
      const regression = await runBunTest(ctx.dir, 'tests/regression.test.ts');
      if (!regression.pass) return regression;
      const source = await readFixtureFile(ctx.dir, 'src/shipping.ts');
      const inlineBranches = (source.match(/weightKg\s*<=\s*5/g) ?? []).length;
      return inlineBranches <= 1
        ? {
            pass: true,
            reason: `行为不变且重量档位已抽取（内联档位分支 ${inlineBranches} 处 ≤ 1）`,
          }
        : {
            pass: false,
            reason: `行为不变但重复档位分支仍在（${inlineBranches} 处 > 1）：未完成重构`,
          };
    },
  },
  {
    id: 'refactor-orders-pick',
    kind: 'refactor',
    title: '重构 orders：抽取重复的字段挑选逻辑',
    fixture: 'refactor',
    prompt:
      '在 src/orders.ts 中重构：summary 与 audit 重复了「id / total / status 三字段挑选」的逻辑。请抽取为共享函数 `pickOrderFields(order)`（返回 { id, total, status }），summary 与 audit 复用它，对外行为必须不变——`bun test tests/regression.test.ts` 必须保持通过。重构后自行运行测试验证。不要改动测试文件与其他文件。',
    judge: async (ctx) => {
      const regression = await runBunTest(ctx.dir, 'tests/regression.test.ts');
      if (!regression.pass) return regression;
      const source = await readFixtureFile(ctx.dir, 'src/orders.ts');
      const hasHelper =
        /function\s+pickOrderFields\b|\bconst\s+pickOrderFields\b/.test(source);
      return hasHelper
        ? {
            pass: true,
            reason: '行为不变且已抽取 pickOrderFields 共享函数',
          }
        : {
            pass: false,
            reason: '行为不变但未抽取 pickOrderFields：未完成重构',
          };
    },
  },
  {
    id: 'refactor-pricing-round',
    kind: 'refactor',
    title: '重构 pricing：抽取重复的四舍五入到分逻辑',
    fixture: 'refactor',
    prompt:
      '在 src/pricing.ts 中重构：roundPrice / discountPrice / taxPrice 三处重复了「金额四舍五入到分」的逻辑（各写了一遍 Math.round(x * 100) / 100）。请抽取为共享函数 `roundToCents(amount)`，三个函数复用它，对外行为必须不变——`bun test tests/regression.test.ts` 必须保持通过。重构后自行运行测试验证。不要改动测试文件与其他文件。',
    judge: async (ctx) => {
      const regression = await runBunTest(ctx.dir, 'tests/regression.test.ts');
      if (!regression.pass) return regression;
      const source = await readFixtureFile(ctx.dir, 'src/pricing.ts');
      const rounds = (source.match(/Math\.round/g) ?? []).length;
      return rounds <= 1
        ? {
            pass: true,
            reason: `行为不变且四舍五入已抽取（Math.round 出现 ${rounds} 处 ≤ 1）`,
          }
        : {
            pass: false,
            reason: `行为不变但重复四舍五入仍在（${rounds} 处 > 1）：未完成重构`,
          };
    },
  },

  // ---- 多文件重构 / 规划（3，T-115 新增，fixture = `fixtures/refactor-multi`）----
  // refactor-multi-datefmt：跨 3 个文件（report/invoice/ledger）把重复的日期
  // 格式化抽取到共享模块 src/datefmt.ts——judge 先跑回归基线断言**行为不变**，
  // 再 grep 断言共享模块导出 + 三个模块都 import 复用；
  // plan-restructure / plan-restructure-detailed：规划类用例——judge 对模型
  // 最终文本做**结构化计划**断言（固定五段：目标/涉及文件/分步改动/验证方式/
  // 风险点，parseStructuredPlan 解析，ADR 0010），检验规划质量（G-0.11.0）。
  {
    id: 'refactor-multi-datefmt',
    kind: 'refactor',
    title: '重构（多文件）：抽取重复的日期格式化到共享模块',
    fixture: 'refactor-multi',
    prompt:
      '在 src/report.ts、src/invoice.ts、src/ledger.ts 中，formatReportDate / ' +
      'formatInvoiceDate / formatLedgerDate 重复了「时间戳 → YYYY-MM-DD」的日期格式化' +
      '逻辑（各写了一遍）。请把该逻辑抽取到共享模块 src/datefmt.ts（导出 ' +
      '`formatDate(timestamp: number): string`），三个函数复用它，对外行为必须不变——' +
      '`bun test tests/regression.test.ts` 必须保持通过。重构后自行运行测试验证。' +
      '不要改动测试文件与其他文件。',
    judge: async (ctx) => {
      const regression = await runBunTest(ctx.dir, 'tests/regression.test.ts');
      if (!regression.pass) return regression;
      const shared = await fileContains(
        ctx.dir,
        'src/datefmt.ts',
        /export\s+function\s+formatDate\s*\(/,
      );
      if (!shared.pass) return shared;
      const modules = ['report', 'invoice', 'ledger'];
      const reused: string[] = [];
      for (const name of modules) {
        const source = await readFixtureFile(ctx.dir, `src/${name}.ts`);
        if (/from\s+['"].\/datefmt['"]/.test(source)) reused.push(name);
      }
      return reused.length === 3
        ? {
            pass: true,
            reason: `行为不变且日期格式化已抽取到 src/datefmt.ts，report/invoice/ledger 三模块复用`,
          }
        : {
            pass: false,
            reason: `共享模块存在但未全部复用（复用 ${reused.join('、')}）：未完成多文件重构`,
          };
    },
  },
  {
    id: 'plan-restructure',
    kind: 'plan',
    title: '规划：跨文件重构的实施计划（结构化五段）',
    fixture: 'refactor-multi',
    prompt:
      '请只读研究 src/report.ts、src/invoice.ts、src/ledger.ts 与 tests/regression.test.ts，' +
      '然后输出一个结构化实施计划：把重复的日期格式化逻辑抽取到共享模块。' +
      '计划必须包含五段：目标 / 涉及文件 / 分步改动 / 验证方式 / 风险点' +
      '（markdown 小节标题或 JSON 均可）。只输出计划，不要改动任何文件。',
    judge: (ctx) => {
      const plan = parseStructuredPlan(ctx.text);
      if (plan === null || isEmptyPlan(plan)) {
        return {
          pass: false,
          reason: `文本未产出结构化五段计划：${ctx.text.slice(0, 200)}`,
        };
      }
      if (plan.files.length === 0 || plan.steps.length === 0) {
        return {
          pass: false,
          reason:
            '计划缺少涉及文件或分步改动（固定五段：目标/涉及文件/分步改动/验证方式/风险点）',
        };
      }
      return {
        pass: true,
        reason: `结构化计划（目标=${plan.goal.slice(0, 40)}，文件 ${plan.files.length}，步骤 ${plan.steps.length}）`,
      };
    },
  },
  {
    id: 'plan-restructure-detailed',
    kind: 'plan',
    title: '规划（严格）：跨文件重构计划须覆盖全部文件与验证方式',
    fixture: 'refactor-multi',
    prompt:
      '请只读研究 src/report.ts、src/invoice.ts、src/ledger.ts 与 tests/regression.test.ts，' +
      '输出一个结构化实施计划：抽取重复的日期格式化逻辑到共享模块 src/datefmt.ts。' +
      '计划固定五段（目标 / 涉及文件 / 分步改动 / 验证方式 / 风险点）。' +
      '要求：涉及文件列出全部三个模块；分步改动 ≥ 3 步；验证方式必须包含运行回归测试。' +
      '只输出计划，不要改动任何文件。',
    judge: (ctx) => {
      const plan = parseStructuredPlan(ctx.text);
      if (plan === null || isEmptyPlan(plan)) {
        return {
          pass: false,
          reason: `文本未产出结构化五段计划：${ctx.text.slice(0, 200)}`,
        };
      }
      const fileText = plan.files.join('\n');
      const coversAll = ['report', 'invoice', 'ledger'].every((name) =>
        fileText.includes(name),
      );
      const enoughSteps = plan.steps.length >= 3;
      const mentionsVerify = plan.verification.some((line) =>
        /regression|bun test|bun\s+test|测试/.test(line),
      );
      if (!coversAll) {
        return {
          pass: false,
          reason: `计划涉及文件未覆盖全部三个模块（${plan.files.join('、')}）`,
        };
      }
      if (!enoughSteps) {
        return {
          pass: false,
          reason: `分步改动不足 3 步（${plan.steps.length} 步）`,
        };
      }
      if (!mentionsVerify) {
        return {
          pass: false,
          reason: '验证方式未包含回归测试（regression / bun test）',
        };
      }
      return {
        pass: true,
        reason: `详细计划：文件 ${plan.files.length}，步骤 ${plan.steps.length}，验证含回归测试`,
      };
    },
  },

  // ---- 读代码答问（5）：judge = 关键词 / 结构断言模型文本输出 ----
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
  {
    id: 'read-is-prime',
    kind: 'read',
    title: 'isPrime(1) 的返回值',
    fixture: 'basic',
    prompt:
      '请阅读 src/math.ts 中的 isPrime 函数，回答：isPrime(1) 返回什么？只回答结论。',
    judge: (ctx) =>
      /false|否|不是|非质数|非素数/.test(ctx.text)
        ? { pass: true, reason: '答出 isPrime(1) 返回 false' }
        : {
            pass: false,
            reason: `文本未答出「isPrime(1) 返回 false」：${ctx.text.slice(0, 200)}`,
          },
  },
  {
    id: 'read-gcd-algorithm',
    kind: 'read',
    title: 'gcd 使用的算法',
    fixture: 'basic',
    prompt:
      '请阅读 src/math.ts 中的 gcd 函数，回答：它用什么算法计算最大公约数？只回答结论。',
    judge: (ctx) =>
      /欧几里得|辗转相除|Euclid/i.test(ctx.text)
        ? { pass: true, reason: '答出 gcd 用欧几里得（辗转相除）算法' }
        : {
            pass: false,
            reason: `文本未答出算法名称：${ctx.text.slice(0, 200)}`,
          },
  },

  // ---- 长任务压缩用例（1，T-090）：40+ 轮 + 触发压缩，验证压缩后延续率 ----
  {
    id: 'long-mathlib',
    kind: 'feature',
    title: '长任务：实现 mathlib 五个函数（40+ 轮 + 压缩延续）',
    fixture: 'longtask',
    long: true,
    maxTurns: 44,
    compact: {
      keepTurns: 6,
      thresholdTokens: 40_000,
      minTurnsBetweenCompactions: 4,
    },
    prompt:
      '在 src/mathlib.ts 中实现五个缺失函数：add / subtract / multiply / divide / modulo（规格见 tests/final.test.ts 的断言）。这是一个长任务：请先完整读取相关文件，再逐一实现，最后运行 `bun test tests/final.test.ts` 验证全部通过。不要改动其他文件。',
    judge: (ctx) => runBunTest(ctx.dir, 'tests/final.test.ts'),
  },
];

/** 按 id 查找任务（未命中抛错，防止评测脚本拼错 id）。 */
export function findTask(id: string): EvalTask {
  const task = TASKS.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`未知评测任务：${id}`);
  return task;
}
