import { describe, expect, test } from 'bun:test';
import { gcd } from '../src/math';

describe('gcd', () => {
  test('欧几里得辗转相除', () => {
    expect(gcd(12, 8)).toBe(4);
    expect(gcd(17, 5)).toBe(1);
    expect(gcd(4, 2)).toBe(2);
  });

  test('gcd(a, 0) = a', () => {
    expect(gcd(7, 0)).toBe(7);
  });
});
