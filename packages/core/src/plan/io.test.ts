import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionRecord } from '../session/log';
import {
  defaultPlansDir,
  loadPlanFromFile,
  rebuildStructuredPlan,
  savePlanToFile,
} from './io';
import { parseStructuredPlan, type StructuredPlan } from './plan';

const PLAN: StructuredPlan = {
  goal: '把重复的字段挑选逻辑抽取为共享函数',
  files: ['src/orders.ts'],
  steps: ['读取现状', '新增 pickOrderFields', '改为复用'],
  verification: ['bun test tests/regression.test.ts 保持通过'],
  risks: ['保持对外行为不变'],
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'modou-plan-io-'));
}

describe('计划文档化（T-113 落盘 / 读回 / 会话重建）', () => {
  test('defaultPlansDir：<projectRoot>/.modou/plans', () => {
    expect(defaultPlansDir('/proj')).toBe('/proj/.modou/plans');
  });

  test('savePlanToFile：写入 markdown，文件名时间戳，可读回解析', async () => {
    const dir = tempDir();
    try {
      const path = await savePlanToFile(dir, PLAN, { now: () => 123456 });
      expect(path).toBe(join(dir, '.modou', 'plans', '123456.md'));
      expect(existsSync(path)).toBe(true);
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('# 实施计划');
      expect(text).toContain('## 目标');
      // 读回：结构化计划与原文一致（手动编辑后再执行的前提）
      const loaded = await loadPlanFromFile(path);
      expect(loaded).toEqual(PLAN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('savePlanToFile：自定义文件名与目录', async () => {
    const dir = tempDir();
    try {
      const customDir = join(dir, 'my-plans');
      const path = await savePlanToFile(dir, PLAN, {
        name: 'refactor-orders',
        dir: customDir,
      });
      expect(path).toBe(join(customDir, 'refactor-orders.md'));
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadPlanFromFile：文件不存在 / 解析失败返回 null', async () => {
    const dir = tempDir();
    try {
      expect(await loadPlanFromFile(join(dir, 'nope.md'))).toBeNull();
      const bad = join(dir, 'bad.md');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(bad, '自由散文没有小节', 'utf8');
      expect(await loadPlanFromFile(bad)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rebuildStructuredPlan：从会话日志最后一条 plan 条目重建', () => {
    const records: SessionRecord[] = [
      { seq: 1, ts: 1, kind: 'user', data: { text: '规划' } },
      {
        seq: 2,
        ts: 2,
        kind: 'plan',
        data: { text: '## 目标\n第一版计划\n## 涉及文件\n- a.ts' },
      },
      { seq: 3, ts: 3, kind: 'user', data: { text: '继续' } },
      {
        seq: 4,
        ts: 4,
        kind: 'plan',
        data: { text: '## 目标\n最终计划\n## 涉及文件\n- b.ts' },
      },
    ];
    const rebuilt = rebuildStructuredPlan(records);
    expect(rebuilt).toBeDefined();
    expect(rebuilt!.goal).toBe('最终计划');
    expect(rebuilt!.files).toEqual(['b.ts']);
  });

  test('rebuildStructuredPlan：无 plan 条目 / 解析失败返回 undefined', () => {
    expect(
      rebuildStructuredPlan([
        { seq: 1, ts: 1, kind: 'user', data: { text: 'hi' } },
      ]),
    ).toBeUndefined();
    expect(
      rebuildStructuredPlan([
        { seq: 1, ts: 1, kind: 'plan', data: { text: '散文' } },
      ]),
    ).toBeUndefined();
  });

  test('落盘 markdown 可经 parseStructuredPlan 解析（与模型产出同路径）', () => {
    const markdown = '## 目标\nX\n## 涉及文件\n- a.ts';
    expect(parseStructuredPlan(markdown)).toEqual({
      goal: 'X',
      files: ['a.ts'],
      steps: [],
      verification: [],
      risks: [],
    });
  });
});
