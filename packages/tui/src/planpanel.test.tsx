import { afterAll, describe, expect, test } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import type { StructuredPlan } from '@modou/core';
import { formatPlanLines, PlanPanel } from './planpanel';

const PLAN: StructuredPlan = {
  goal: '把重复的字段挑选逻辑抽取为共享函数',
  files: ['src/orders.ts'],
  steps: ['读取现状', '新增 pickOrderFields', '改为复用'],
  verification: ['bun test tests/regression.test.ts 保持通过'],
  risks: ['保持对外行为不变'],
};

/** 等 React / Ink 处理输入并渲染（useInput 是异步的，连续按键之间需要 tick）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('PlanPanel（T-112 计划面板）', () => {
  afterAll(() => {
    cleanup();
  });

  test('formatPlanLines：五段 markdown 行', () => {
    const lines = formatPlanLines(PLAN);
    expect(lines[0]).toBe('# 实施计划');
    expect(lines).toContain('## 目标');
    expect(lines).toContain('## 涉及文件');
    expect(lines).toContain('## 分步改动');
    expect(lines).toContain('## 验证方式');
    expect(lines).toContain('## 风险点');
    expect(lines).toContain('- src/orders.ts');
    // 空段输出「（无）」
    const empty = formatPlanLines({ ...PLAN, risks: [] });
    expect(empty).toContain('（无）');
  });

  test('渲染：标题 + 五段 + 操作提示', () => {
    const { lastFrame, unmount } = render(
      <PlanPanel
        plan={PLAN}
        onApprove={() => {}}
        onReject={() => {}}
        onEdit={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('计划提案');
    expect(frame).toContain('把重复的字段挑选逻辑抽取为共享函数');
    expect(frame).toContain('a 批准');
    unmount();
  });

  test('键盘 a 批准 / r 拒绝 / e 修改', async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PlanPanel
        plan={PLAN}
        onApprove={() => calls.push('approve')}
        onReject={() => calls.push('reject')}
        onEdit={() => calls.push('edit')}
      />,
    );
    await flush(); // 等 useInput 注册就绪
    stdin.write('a');
    await flush();
    stdin.write('r');
    await flush();
    stdin.write('e');
    await flush();
    expect(calls).toEqual(['approve', 'reject', 'edit']);
    unmount();
  });
});
