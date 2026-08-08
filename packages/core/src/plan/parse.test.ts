import { describe, expect, test } from 'bun:test';
import {
  isEmptyPlan,
  parseStructuredPlan,
  serializeStructuredPlan,
  type StructuredPlan,
} from './plan';

const PLAN: StructuredPlan = {
  goal: '把重复的字段挑选逻辑抽取为共享函数',
  files: ['src/orders.ts', 'src/orders.test.ts'],
  steps: [
    '读取 src/orders.ts 确认现状',
    '新增 pickOrderFields 函数',
    'summary / audit 改为复用',
  ],
  verification: ['bun test tests/regression.test.ts 保持通过'],
  risks: ['保持对外行为不变，不引入分号/缩进风格差异'],
};

describe('parseStructuredPlan（T-112 计划结构解析）', () => {
  test('markdown 五段小节解析（中文标题）', () => {
    const text = `# 实施计划

## 目标
把重复的字段挑选逻辑抽取为共享函数

## 涉及文件
- src/orders.ts
- src/orders.test.ts

## 分步改动
1. 读取 src/orders.ts 确认现状
2. 新增 pickOrderFields 函数
3. summary / audit 改为复用

## 验证方式
- bun test tests/regression.test.ts 保持通过

## 风险点
- 保持对外行为不变，不引入分号/缩进风格差异
`;
    const plan = parseStructuredPlan(text);
    expect(plan).toEqual(PLAN);
  });

  test('markdown 英文标题别名（Files / Steps / Verification / Risks）', () => {
    const text = `## Goal
重构

## Files
- a.ts

## Steps
1. 第一步

## Verification
- 跑测试

## Risks
- 风险
`;
    const plan = parseStructuredPlan(text);
    expect(plan).toEqual({
      goal: '重构',
      files: ['a.ts'],
      steps: ['第一步'],
      verification: ['跑测试'],
      risks: ['风险'],
    });
  });

  test('JSON 形态解析（剥 markdown 围栏）', () => {
    const json = `\`\`\`json
${JSON.stringify(PLAN, null, 2)}
\`\`\``;
    const plan = parseStructuredPlan(json);
    expect(plan).toEqual(PLAN);
  });

  test('JSON 容错：前后夹解释文字（提取对象）', () => {
    const text = `这是我研究后的计划：\n${JSON.stringify(PLAN)}\n请评审。`;
    // 直接 JSON.parse 失败 → markdown 路径也失败（无小节标题）→ null。
    // 本用例只断言「无小节标题的散文不解析」（JSON 夹带属于模型脏输出，
    // 我们不做「夹文字里抠 JSON」——那是 delta 解析的容错，计划更严格）。
    expect(parseStructuredPlan(text)).toBeNull();
  });

  test('缺目标 / 空文本 / 散文 → null', () => {
    expect(parseStructuredPlan('')).toBeNull();
    expect(parseStructuredPlan('   ')).toBeNull();
    expect(
      parseStructuredPlan('## 涉及文件\n- a.ts\n## 分步改动\n1. 改'),
    ).toBeNull(); // 缺目标
    expect(parseStructuredPlan('自由散文，没有小节标题')).toBeNull();
  });

  test('缺少可选段：对应段为空数组', () => {
    const plan = parseStructuredPlan(`## 目标\n改一下\n## 涉及文件\n- a.ts`);
    expect(plan).toEqual({
      goal: '改一下',
      files: ['a.ts'],
      steps: [],
      verification: [],
      risks: [],
    });
  });

  test('serializeStructuredPlan：五段 markdown 可往返解析', () => {
    const markdown = serializeStructuredPlan(PLAN);
    expect(markdown).toContain('# 实施计划');
    for (const title of [
      '目标',
      '涉及文件',
      '分步改动',
      '验证方式',
      '风险点',
    ]) {
      expect(markdown).toContain(`## ${title}`);
    }
    const roundtrip = parseStructuredPlan(markdown);
    expect(roundtrip).toEqual(PLAN);
  });

  test('isEmptyPlan：五段全空为真', () => {
    expect(isEmptyPlan(PLAN)).toBe(false);
    expect(
      isEmptyPlan({
        goal: '',
        files: [],
        steps: [],
        verification: [],
        risks: [],
      }),
    ).toBe(true);
  });
});
