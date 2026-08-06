import { describe, expect, test } from 'bun:test';
import { version } from './index';

describe('@modou/core', () => {
  test('exports a string version', () => {
    expect(version).toBeTypeOf('string');
    expect(version.length).toBeGreaterThan(0);
  });
});
