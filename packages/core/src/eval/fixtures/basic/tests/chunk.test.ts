import { describe, expect, test } from 'bun:test';
import { chunk } from '../src/array';

describe('chunk', () => {
  test('整组切块', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test('余数块保留', () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  test('空数组', () => {
    expect(chunk([], 3)).toEqual([]);
  });
});
