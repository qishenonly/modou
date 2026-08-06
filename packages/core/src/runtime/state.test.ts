import { describe, expect, test } from 'bun:test';
import { canTransition, nextState, stopReasonToTransition } from './state';

describe('Agent loop 状态机（state.ts）', () => {
  test('stop_reason → 迁移映射', () => {
    expect(stopReasonToTransition('tool_use')).toEqual({
      transition: 'tool_use',
      to: 'executing',
    });
    expect(stopReasonToTransition('stop')).toEqual({
      transition: 'end_turn',
      to: 'idle',
    });
    expect(stopReasonToTransition('length')).toEqual({
      transition: 'end_turn',
      to: 'idle',
    });
    expect(stopReasonToTransition('content-filter')).toEqual({
      transition: 'end_turn',
      to: 'idle',
    });
    expect(stopReasonToTransition('other')).toEqual({
      transition: 'end_turn',
      to: 'idle',
    });
    expect(stopReasonToTransition('error')).toEqual({
      transition: 'error',
      to: 'halted',
    });
  });

  test('合法迁移（对齐 002 4.3 状态图）', () => {
    expect(canTransition('idle', 'submit')).toBe('assemble');
    expect(canTransition('assemble', 'request_started')).toBe('streaming');
    expect(canTransition('assemble', 'limits_exceeded')).toBe('halted');
    expect(canTransition('streaming', 'tool_use')).toBe('executing');
    expect(canTransition('streaming', 'end_turn')).toBe('idle');
    expect(canTransition('streaming', 'interrupt')).toBe('interrupted');
    expect(canTransition('streaming', 'limits_exceeded')).toBe('halted');
    expect(canTransition('streaming', 'error')).toBe('halted');
    expect(canTransition('executing', 'tool_result_logged')).toBe('assemble');
    expect(canTransition('interrupted', 'steer')).toBe('assemble');
    expect(canTransition('interrupted', 'no_follow_up')).toBe('idle');
  });

  test('非法迁移返回 null；halted 是终态', () => {
    expect(canTransition('idle', 'interrupt')).toBeNull();
    expect(canTransition('idle', 'tool_use')).toBeNull();
    expect(canTransition('executing', 'submit')).toBeNull();
    expect(canTransition('halted', 'submit')).toBeNull();
    expect(canTransition('halted', 'limits_exceeded')).toBeNull();
  });

  test('nextState 对非法迁移抛错（不变量守卫）', () => {
    expect(() => nextState('idle', 'interrupt')).toThrow(/非法状态迁移/);
    expect(() => nextState('halted', 'request_started')).toThrow(
      /非法状态迁移/,
    );
  });
});
