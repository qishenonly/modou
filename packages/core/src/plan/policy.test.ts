import { describe, expect, test } from 'bun:test';
import { defaultWriteTools, defaultReadonlyTools } from '../tools';
import { ToolRegistry } from '../tools/registry';
import {
  PLAN_MODE_INSTRUCTION,
  PLAN_MODE_TOOL_NAMES,
  planReadonlyRegistry,
} from './policy';

describe('Plan Mode 策略（T-112 只读白名单）', () => {
  test('白名单按工具名：read / grep / glob（不含 risk: read 的 todo_write）', () => {
    expect(PLAN_MODE_TOOL_NAMES).toEqual(['read', 'grep', 'glob']);
    // todo_write 的 risk 是 read，但语义上属于执行能力，不进入白名单（ADR 0010）
    expect(PLAN_MODE_TOOL_NAMES).not.toContain('todo_write');
  });

  test('planReadonlyRegistry：从完整写工具集派生只读注册表', () => {
    const full = defaultWriteTools();
    const readonly = planReadonlyRegistry(full);
    expect(readonly.names()).toEqual(['read', 'grep', 'glob']);
    // 写/执行工具与清单工具都不在白名单内
    for (const name of ['write', 'edit', 'bash', 'todo_write']) {
      expect(readonly.has(name)).toBe(false);
    }
    // 不修改入参注册表
    expect(full.has('write')).toBe(true);
    expect(full.size).toBe(7);
  });

  test('planReadonlyRegistry：白名单外的注册表仅保留命中的工具', () => {
    const custom = new ToolRegistry();
    custom.register({
      name: 'read',
      description: 'read',
      risk: 'read',
      schema: { safeParse: () => ({ success: true as const }) } as never,
      execute: async () => ({ ok: true, forModel: '' }),
    });
    const readonly = planReadonlyRegistry(custom);
    expect(readonly.names()).toEqual(['read']);
  });

  test('模型指令：要求只读研究与固定五段结构，且声明无写工具', () => {
    expect(PLAN_MODE_INSTRUCTION).toContain('计划模式');
    expect(PLAN_MODE_INSTRUCTION).toContain('read / grep / glob');
    expect(PLAN_MODE_INSTRUCTION).toContain('不要尝试调用它们');
    for (const section of [
      '目标',
      '涉及文件',
      '分步改动',
      '验证方式',
      '风险点',
    ]) {
      expect(PLAN_MODE_INSTRUCTION).toContain(section);
    }
  });

  test('planReadonlyRegistry 幂等：两次派生互不干扰、结果一致', () => {
    const full = defaultReadonlyTools();
    const a = planReadonlyRegistry(full);
    const b = planReadonlyRegistry(full);
    expect(a.names()).toEqual(b.names());
  });
});
