import { describe, expect, test } from 'bun:test';
import { capitalize } from '../src/string';

describe('capitalize', () => {
  test('首字母大写、其余保持原样', () => {
    expect(capitalize('hello')).toBe('Hello');
  });

  test('已大写开头保持不变', () => {
    expect(capitalize('World')).toBe('World');
  });

  test('空字符串', () => {
    expect(capitalize('')).toBe('');
  });
});
