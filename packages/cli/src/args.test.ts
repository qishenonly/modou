import { describe, expect, test } from 'bun:test';
import { parseArgs, UsageError } from './args';

describe('parseArgs（-p 参数解析）', () => {
  test('-p 与 --prompt 等价，支持 --prompt= 形式', () => {
    expect(parseArgs(['-p', '你好'])).toEqual({
      prompt: '你好',
      help: false,
      autoApprove: false,
    });
    expect(parseArgs(['--prompt', '你好'])).toEqual({
      prompt: '你好',
      help: false,
      autoApprove: false,
    });
    expect(parseArgs(['--prompt=你好'])).toEqual({
      prompt: '你好',
      help: false,
      autoApprove: false,
    });
  });

  test('提示词可含空格（作为单个 argv 传入）', () => {
    expect(parseArgs(['-p', '请用中文回答'])).toEqual({
      prompt: '请用中文回答',
      help: false,
      autoApprove: false,
    });
  });

  test('--help 返回帮助标志，可与 -p 共存', () => {
    expect(parseArgs(['--help'])).toEqual({
      prompt: undefined,
      help: true,
      autoApprove: false,
    });
    expect(parseArgs(['-h'])).toEqual({
      prompt: undefined,
      help: true,
      autoApprove: false,
    });
    expect(parseArgs(['-p', '你好', '-h'])).toEqual({
      prompt: '你好',
      help: true,
      autoApprove: false,
    });
  });

  test('--auto-approve：布尔标志，缺省 false', () => {
    expect(parseArgs(['--auto-approve'])).toEqual({
      prompt: undefined,
      help: false,
      autoApprove: true,
    });
    expect(parseArgs(['-p', '你好', '--auto-approve'])).toEqual({
      prompt: '你好',
      help: false,
      autoApprove: true,
    });
    // 与 -h 可共存
    expect(parseArgs(['--auto-approve', '--help'])).toEqual({
      prompt: undefined,
      help: true,
      autoApprove: true,
    });
  });

  test('空参数：未给 -p 且无 --help → prompt 为 undefined', () => {
    expect(parseArgs([])).toEqual({
      prompt: undefined,
      help: false,
      autoApprove: false,
    });
  });

  test('缺 -p 参数值抛 UsageError', () => {
    expect(() => parseArgs(['-p'])).toThrow(UsageError);
    expect(() => parseArgs(['--prompt'])).toThrow(UsageError);
    expect(() => parseArgs(['--prompt='])).toThrow(UsageError);
    expect(() => parseArgs(['-p', '--help'])).toThrow(UsageError);
    expect(() => parseArgs(['-p', '--auto-approve'])).toThrow(UsageError);
  });

  test('未知参数与意外位置参数抛 UsageError', () => {
    expect(() => parseArgs(['-x'])).toThrow(UsageError);
    expect(() => parseArgs(['裸输入'])).toThrow(UsageError);
  });
});
