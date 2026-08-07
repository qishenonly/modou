import { describe, expect, test } from 'bun:test';
import { clamp } from '../src/math';

describe('clamp', () => {
  test('区间内原样返回', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  test('低于下界夹到 min', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  test('高于上界夹到 max', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
