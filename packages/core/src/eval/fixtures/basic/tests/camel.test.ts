import { describe, expect, test } from 'bun:test';
import { camelToSnake } from '../src/format';

describe('camelToSnake', () => {
  test("'myVar' → 'my_var'", () => {
    expect(camelToSnake('myVar')).toBe('my_var');
  });

  test('全小写输入保持不变', () => {
    expect(camelToSnake('abc')).toBe('abc');
  });
});
