import { describe, expect, test } from 'bun:test';
import { fibonacci } from '../src/math';

describe('fibonacci', () => {
  test('fibonacci(0) === 0', () => {
    expect(fibonacci(0)).toBe(0);
  });

  test('fibonacci(6) === 8', () => {
    expect(fibonacci(6)).toBe(8);
  });
});
