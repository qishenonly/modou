import { describe, expect, test } from 'bun:test';
import { ProviderError } from '../provider/errors';
import {
  createInterruptHandle,
  extractInterruptReason,
  isInterruptError,
} from './interrupt';

describe('中断工具（interrupt.ts）', () => {
  test('句柄：初始未中断，abort 后记录原因', () => {
    const handle = createInterruptHandle();
    expect(handle.aborted).toBe(false);
    expect(handle.signal.aborted).toBe(false);

    const reason = new Error('用户打断');
    handle.abort(reason);

    expect(handle.aborted).toBe(true);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.reason).toBe(reason);
  });

  test('isInterruptError 只认 aborted 类错误', () => {
    expect(
      isInterruptError(new ProviderError({ kind: 'aborted', message: '中断' })),
    ).toBe(true);
    expect(
      isInterruptError(
        new ProviderError({ kind: 'server_error', message: '500' }),
      ),
    ).toBe(false);
    expect(isInterruptError(new Error('普通错误'))).toBe(false);
  });

  test('extractInterruptReason：优先 signal.reason，回退错误 cause', () => {
    const handle = createInterruptHandle();
    const reason = new Error('退出');
    handle.abort(reason);
    expect(extractInterruptReason(handle.signal, undefined)).toBe(reason);

    const cause = new Error('底层中断');
    const err = new ProviderError({ kind: 'aborted', message: '中断', cause });
    expect(extractInterruptReason(undefined, err)).toBe(cause);

    expect(extractInterruptReason(undefined, undefined)).toBeUndefined();
  });
});
