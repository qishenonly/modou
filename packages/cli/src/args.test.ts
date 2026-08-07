import { describe, expect, test } from 'bun:test';
import { parseArgs, UsageError } from './args';

/** 缺省参数结果（无 addDirs 时）。 */
function base(overrides: Partial<ReturnType<typeof parseArgs>> = {}) {
  return {
    prompt: undefined,
    help: false,
    autoApprove: false,
    addDirs: [],
    ...overrides,
  };
}

describe('parseArgs（-p 参数解析）', () => {
  test('-p 与 --prompt 等价，支持 --prompt= 形式', () => {
    expect(parseArgs(['-p', '你好'])).toEqual(base({ prompt: '你好' }));
    expect(parseArgs(['--prompt', '你好'])).toEqual(base({ prompt: '你好' }));
    expect(parseArgs(['--prompt=你好'])).toEqual(base({ prompt: '你好' }));
  });

  test('提示词可含空格（作为单个 argv 传入）', () => {
    expect(parseArgs(['-p', '请用中文回答'])).toEqual(
      base({ prompt: '请用中文回答' }),
    );
  });

  test('--help 返回帮助标志，可与 -p 共存', () => {
    expect(parseArgs(['--help'])).toEqual(base({ help: true }));
    expect(parseArgs(['-h'])).toEqual(base({ help: true }));
    expect(parseArgs(['-p', '你好', '-h'])).toEqual(
      base({ prompt: '你好', help: true }),
    );
  });

  test('--auto-approve：布尔标志，缺省 false', () => {
    expect(parseArgs(['--auto-approve'])).toEqual(base({ autoApprove: true }));
    expect(parseArgs(['-p', '你好', '--auto-approve'])).toEqual(
      base({ prompt: '你好', autoApprove: true }),
    );
    // 与 -h 可共存
    expect(parseArgs(['--auto-approve', '--help'])).toEqual(
      base({ help: true, autoApprove: true }),
    );
  });

  test('--add-dir：白名单目录可重复收集，支持 --add-dir= 形式', () => {
    expect(parseArgs(['--add-dir', './shared'])).toEqual(
      base({ addDirs: ['./shared'] }),
    );
    expect(parseArgs(['--add-dir=./a', '--add-dir', './b'])).toEqual(
      base({ addDirs: ['./a', './b'] }),
    );
    // 与 -p / --auto-approve 可共存
    expect(
      parseArgs(['-p', 'hi', '--auto-approve', '--add-dir', '/tmp/x']),
    ).toEqual(base({ prompt: 'hi', autoApprove: true, addDirs: ['/tmp/x'] }));
  });

  test('空参数：未给 -p 且无 --help → prompt 为 undefined', () => {
    expect(parseArgs([])).toEqual(base());
  });

  test('缺 -p 参数值抛 UsageError', () => {
    expect(() => parseArgs(['-p'])).toThrow(UsageError);
    expect(() => parseArgs(['--prompt'])).toThrow(UsageError);
    expect(() => parseArgs(['--prompt='])).toThrow(UsageError);
    expect(() => parseArgs(['-p', '--help'])).toThrow(UsageError);
    expect(() => parseArgs(['-p', '--auto-approve'])).toThrow(UsageError);
  });

  test('缺 --add-dir 参数值抛 UsageError', () => {
    expect(() => parseArgs(['--add-dir'])).toThrow(UsageError);
    expect(() => parseArgs(['--add-dir='])).toThrow(UsageError);
    expect(() => parseArgs(['--add-dir', '--auto-approve'])).toThrow(
      UsageError,
    );
  });

  test('未知参数与意外位置参数抛 UsageError', () => {
    expect(() => parseArgs(['-x'])).toThrow(UsageError);
    expect(() => parseArgs(['裸输入'])).toThrow(UsageError);
  });
});
