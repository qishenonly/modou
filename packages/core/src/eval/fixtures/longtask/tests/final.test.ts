import { describe, expect, test } from 'bun:test';
import { add, divide, modulo, multiply, subtract } from '../src/mathlib';

/**
 * 长任务验收测试：五个函数全部实现且行为正确。
 * 该测试是 long-mathlib 任务的判定器，也是「压缩后任务延续率」的依据——
 * 会话中途发生压缩后，模型仍记得要实现哪五个函数（压缩摘要里保留的目标）。
 */
describe('mathlib 全函数（长任务验收）', () => {
  test('四则运算与取模', () => {
    expect(add(2, 3)).toBe(5);
    expect(subtract(5, 8)).toBe(-3);
    expect(multiply(4, 6)).toBe(24);
    expect(divide(10, 4)).toBe(2.5);
    expect(modulo(10, 3)).toBe(1);
  });
});
