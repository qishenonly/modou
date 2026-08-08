/**
 * 示例钩子可执行测试（T-143）：scripts/hooks/ 下三个开箱示例实测生效
 * （G-0.14.0 验收门「三个示例钩子实测生效」）。
 *
 * 全部离线：spawn 本机运行时可执行文件（process.execPath）跑 .mjs 脚本，
 * 不访问任何外部服务；lint 示例用 `true` / `false` 命令模拟 lint 通过 / 失败。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hooksFromSettings } from './config';
import { runHookProcess, type HookProcessSpec } from './executor';

/** 仓库内示例钩子目录（本文件在 packages/core/src/hooks/，上溯到仓库根）。 */
const HOOKS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'hooks',
);

/** 用 process.execPath（本机运行时）跑示例脚本的规格。 */
function exampleSpec(
  name: string,
  extra: Partial<HookProcessSpec> = {},
): HookProcessSpec {
  const script = join(HOOKS_DIR, name);
  if (!existsSync(script)) {
    throw new Error(`示例脚本不存在：${script}`);
  }
  return { command: process.execPath, args: [script], ...extra };
}

// ---------------------------------------------------------------------------
// block-dangerous：拦截危险命令
// ---------------------------------------------------------------------------

describe('示例钩子：block-dangerous（拦截危险命令）', () => {
  test('rm -rf / 被 deny，理由回喂', async () => {
    const invocation = await runHookProcess(
      'PreToolUse',
      {
        v: 1,
        point: 'PreToolUse',
        toolName: 'bash',
        toolInput: { command: 'rm -rf /' },
      },
      exampleSpec('block-dangerous.mjs'),
      { hookId: 'example-block' },
    );
    expect(invocation.degraded).toBe(false);
    expect(invocation.result).toMatchObject({ decision: 'deny' });
    expect(invocation.result.reason).toContain('危险命令');
  });

  test('普通命令直通 allow', async () => {
    const invocation = await runHookProcess(
      'PreToolUse',
      {
        v: 1,
        point: 'PreToolUse',
        toolName: 'bash',
        toolInput: { command: 'ls -la' },
      },
      exampleSpec('block-dangerous.mjs'),
      { hookId: 'example-block' },
    );
    expect(invocation.result).toMatchObject({ decision: 'allow' });
  });

  test('git push --force 被 deny', async () => {
    const invocation = await runHookProcess(
      'PreToolUse',
      {
        v: 1,
        point: 'PreToolUse',
        toolName: 'bash',
        toolInput: { command: 'git push origin main --force' },
      },
      exampleSpec('block-dangerous.mjs'),
      { hookId: 'example-block' },
    );
    expect(invocation.result).toMatchObject({ decision: 'deny' });
  });
});

// ---------------------------------------------------------------------------
// format-after-edit：编辑后自动 format
// ---------------------------------------------------------------------------

describe('示例钩子：format-after-edit（编辑后自动 format）', () => {
  test('无 MODOU_FORMAT_CMD 时恒 continue（副作用缺省不触发）', async () => {
    const invocation = await runHookProcess(
      'PostToolUse',
      {
        v: 1,
        point: 'PostToolUse',
        toolName: 'edit',
        toolInput: { path: '/nonexistent/a.ts' },
        toolResult: { ok: true, forModel: 'ok' },
      },
      exampleSpec('format-after-edit.mjs'),
      { hookId: 'example-format' },
    );
    expect(invocation.degraded).toBe(false);
    expect(invocation.result).toMatchObject({ decision: 'continue' });
  });

  test('配置 MODOU_FORMAT_CMD 时对改写的文件跑格式化命令（恒 continue）', async () => {
    // 用 `true` 模拟格式化命令成功：目标文件写进临时目录再格式化
    const invocation = await runHookProcess(
      'PostToolUse',
      {
        v: 1,
        point: 'PostToolUse',
        toolName: 'write',
        toolInput: { path: '/tmp/modou-hook-example.txt' },
        toolResult: { ok: true, forModel: 'written' },
      },
      exampleSpec('format-after-edit.mjs', {
        env: { MODOU_FORMAT_CMD: 'true' },
      }),
      { hookId: 'example-format' },
    );
    expect(invocation.result).toMatchObject({ decision: 'continue' });
  });
});

// ---------------------------------------------------------------------------
// lint-before-commit：提交前跑 lint
// ---------------------------------------------------------------------------

describe('示例钩子：lint-before-commit（提交前跑 lint）', () => {
  test('非 commit 命令直通 allow', async () => {
    const invocation = await runHookProcess(
      'PreToolUse',
      {
        v: 1,
        point: 'PreToolUse',
        toolName: 'bash',
        toolInput: { command: 'ls' },
      },
      exampleSpec('lint-before-commit.mjs'),
      { hookId: 'example-lint' },
    );
    expect(invocation.result).toMatchObject({ decision: 'allow' });
  });

  test('git commit + lint 通过 → allow', async () => {
    const invocation = await runHookProcess(
      'PreToolUse',
      {
        v: 1,
        point: 'PreToolUse',
        toolName: 'bash',
        toolInput: { command: 'git commit -m "feat: x"' },
      },
      exampleSpec('lint-before-commit.mjs', {
        env: { MODOU_LINT_CMD: 'true' },
      }),
      { hookId: 'example-lint' },
    );
    expect(invocation.degraded).toBe(false);
    expect(invocation.result).toMatchObject({ decision: 'allow' });
    expect(invocation.result.reason).toContain('lint 通过');
  });

  test('git commit + lint 失败 → deny（理由含 lint 输出摘要）', async () => {
    const invocation = await runHookProcess(
      'PreToolUse',
      {
        v: 1,
        point: 'PreToolUse',
        toolName: 'bash',
        toolInput: { command: 'git commit -m "wip"' },
      },
      exampleSpec('lint-before-commit.mjs', {
        env: { MODOU_LINT_CMD: 'false' },
      }),
      { hookId: 'example-lint' },
    );
    expect(invocation.degraded).toBe(false);
    expect(invocation.result).toMatchObject({ decision: 'deny' });
    expect(invocation.result.reason).toContain('lint 未通过');
  });
});

// ---------------------------------------------------------------------------
// hooksFromSettings：settings.json hooks 键 → HookBus
// ---------------------------------------------------------------------------

describe('hooksFromSettings 装配（T-143）', () => {
  test('settings 条目按钩子点 + 工具匹配器注册，deny 经总线生效', async () => {
    const script = join(HOOKS_DIR, 'block-dangerous.mjs');
    const bus = hooksFromSettings({
      PreToolUse: [
        {
          command: process.execPath,
          args: [script],
          matcher: { tools: ['bash'] },
        },
      ],
    });
    expect(bus).toBeDefined();
    const registrations = bus?.list('PreToolUse') ?? [];
    expect(registrations).toHaveLength(1);
    expect(registrations[0].id).toBe('config-PreToolUse-1');

    const blocked = await bus?.run('PreToolUse', {
      point: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'rm -rf /' },
    });
    expect(blocked?.[0].result).toMatchObject({ decision: 'deny' });

    // 匹配器不命中（edit）→ 空批次
    const onEdit = await bus?.run('PreToolUse', {
      point: 'PreToolUse',
      toolName: 'edit',
      toolInput: { path: 'a.ts' },
    });
    expect(onEdit).toHaveLength(0);
  });

  test('配置缺省 / 全空点 → undefined（管线直通）', () => {
    expect(hooksFromSettings(undefined)).toBeUndefined();
    expect(hooksFromSettings({})).toBeUndefined();
    expect(hooksFromSettings({ PreToolUse: [] })).toBeUndefined();
  });
});
