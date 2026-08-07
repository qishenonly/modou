import { describe, expect, test } from 'bun:test';
import { average } from '../src/math';

describe('average', () => {
  test('average([1, 2, 3]) === 2', () => {
    expect(average([1, 2, 3])).toBe(2);
  });

  test('average([5]) === 5（单元素不除零）', () => {
    expect(average([5])).toBe(5);
  });
});
