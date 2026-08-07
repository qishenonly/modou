import { describe, expect, test } from 'bun:test';
import { isPrime } from '../src/math';
import { reverseString } from '../src/string';

describe('回归基线（正确实现不应被改动破坏）', () => {
  test('isPrime 基本判定', () => {
    expect(isPrime(2)).toBe(true);
    expect(isPrime(4)).toBe(false);
    expect(isPrime(17)).toBe(true);
  });

  test('reverseString 反转', () => {
    expect(reverseString('abc')).toBe('cba');
    expect(reverseString('')).toBe('');
  });
});
