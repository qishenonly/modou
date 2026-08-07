import { describe, expect, test, mock } from 'bun:test';
import type { HeadlessOptions } from './headless';

// ---------------------------------------------------------------------------
// main 装配测试（T-034：CLI 用 defaultWriteTools + 透传 autoApprove）
//
// 不跑真实模型：mock 掉 runHeadless（捕获装配参数），provider 用占位环境变量
// 装配（createProviderFromEnv 只构造对象、不发请求，runHeadless 被 mock 后
// 根本用不到 provider）。验证 main 的「装配逻辑」——传入的 tools 是写工具集
// （write/edit/bash），autoApprove 按 --auto-approve 透传。
// ---------------------------------------------------------------------------

/** 捕获 runHeadless 每次收到的选项（代替真实运行）。 */
const headlessCalls: HeadlessOptions[] = [];

mock.module('./headless', () => ({
  runHeadless: async (options: HeadlessOptions) => {
    headlessCalls.push(options);
    return {
      result: {
        text: '',
        usage: {},
        finishReason: 'stop',
        termination: 'end_turn',
        turns: 1,
        state: 'idle',
      },
      envelopes: [],
    };
  },
}));

// mock.module 注册后再加载 main（Bun 按需解析模块）
const { main } = await import('./main');

/** 用占位环境变量满足 createProviderFromEnv（构造即成功、不发请求）。 */
function withOpencodeEnv(run: () => Promise<number>): Promise<number> {
  const keys = [
    'MODOU_OPENCODE_API_KEY',
    'MODOU_OPENCODE_BASE_URL',
    'MODOU_TEST_MODEL_DEEPSEEK',
    'MODOU_TEST_MODEL_GPT',
  ] as const;
  const prev = new Map<string, string | undefined>(
    keys.map((key) => [key, process.env[key]]),
  );
  process.env.MODOU_OPENCODE_API_KEY = 'stub-key';
  process.env.MODOU_OPENCODE_BASE_URL = 'https://stub.example/v1';
  process.env.MODOU_TEST_MODEL_DEEPSEEK = 'stub-deepseek';
  process.env.MODOU_TEST_MODEL_GPT = 'stub-gpt';
  try {
    return run();
  } finally {
    for (const key of keys) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('main（CLI 装配：写工具集 + autoApprove）', () => {
  test('装配写工具集：runHeadless 收到含 write / edit / bash 的 defaultWriteTools', async () => {
    headlessCalls.length = 0;
    const code = await withOpencodeEnv(() => main(['-p', 'hi']));

    expect(code).toBe(0);
    expect(headlessCalls).toHaveLength(1);
    const tools = headlessCalls[0]?.tools;
    expect(tools).toBeDefined();
    expect(tools?.names()).toEqual(
      expect.arrayContaining(['read', 'grep', 'glob', 'write', 'edit', 'bash']),
    );
  });

  test('无 --auto-approve：autoApprove 为 false（默认拒绝）', async () => {
    headlessCalls.length = 0;
    await withOpencodeEnv(() => main(['-p', 'hi']));

    expect(headlessCalls[0]?.autoApprove).toBe(false);
  });

  test('--auto-approve：autoApprove 透传为 true', async () => {
    headlessCalls.length = 0;
    const code = await withOpencodeEnv(() =>
      main(['--auto-approve', '-p', 'hi']),
    );

    expect(code).toBe(0);
    expect(headlessCalls[0]?.autoApprove).toBe(true);
  });
});
