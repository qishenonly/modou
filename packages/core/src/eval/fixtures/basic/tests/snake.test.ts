import { describe, expect, test } from 'bun:test';
import { snakeToCamel } from '../src/format';

describe('snakeToCamel', () => {
  test("'my_var' → 'myVar'", () => {
    expect(snakeToCamel('my_var')).toBe('myVar');
  });

  test('多段下划线逐词转驼峰', () => {
    expect(snakeToCamel('long_name_here')).toBe('longNameHere');
  });

  test('无下划线保持不变', () => {
    expect(snakeToCamel('abc')).toBe('abc');
  });
});
