import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runToolPipeline } from '../pipeline';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import {
  BASH_TIMEOUT_MAX,
  bashSchema,
  bashTool,
  createBashTool,
  type BashPayload,
} from './bash';
import { defaultWriteTools } from './index';

/**
 * Bash 工具测试（T-032）：全部离线，只跑无害命令（echo / ls / true / exit /
 * seq / sleep 短 / pwd / kill -9 $$），禁止 rm -rf 等危险操作；沙箱环境用真实 bash。
 * fixture 都写在临时目录（os.tmpdir()），不读仓库外的任何既有路径。
 */

let tmpDir: string;

function makeCtx(cwd: string = tmpDir): ToolContext {
  return { signal: new AbortController().signal, cwd };
}

function payloadOf(outcome: { readonly payload?: unknown }): BashPayload {
  return outcome.payload as BashPayload;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'modou-bash-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('bashTool 基本形态', () => {
  test('工具名 / 风险 / schema 合理', () => {
    expect(bashTool.name).toBe('bash');
    expect(bashTool.risk).toBe('exec');
    expect(bashTool.schema).toBe(bashSchema);
  });

  test('schema：command 必填非空；cwd / timeoutMs 校验', () => {
    expect(bashSchema.safeParse({}).success).toBe(false); // 缺 command
    expect(bashSchema.safeParse({ command: '' }).success).toBe(false); // 空命令
    expect(bashSchema.safeParse({ command: 'ls' }).success).toBe(true);
    expect(bashSchema.safeParse({ command: 'ls', cwd: '/tmp' }).success).toBe(
      true,
    );
    expect(bashSchema.safeParse({ command: 'ls', cwd: '' }).success).toBe(
      false,
    );
    expect(
      bashSchema.safeParse({ command: 'ls', timeoutMs: 1_000 }).success,
    ).toBe(true);
    expect(
      bashSchema.safeParse({
        command: 'ls',
        timeoutMs: BASH_TIMEOUT_MAX + 1,
      }).success,
    ).toBe(false); // 超上限
    expect(bashSchema.safeParse({ command: 'ls', timeoutMs: -1 }).success).toBe(
      false,
    ); // 非正数
    expect(
      bashSchema.safeParse({ command: 'ls', timeoutMs: 1.5 }).success,
    ).toBe(false); // 非整数
  });
});

describe('bashTool 执行', () => {
  test('成功：echo 输出回喂，exitCode 0', async () => {
    const outcome = await bashTool.execute(
      { command: 'echo hello' },
      makeCtx(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.forModel).toContain('退出码 0');
    expect(outcome.forModel).toContain('hello');
    const payload = payloadOf(outcome);
    expect(payload.exitCode).toBe(0);
    expect(payload.stdout).toContain('hello');
    expect(payload.stderr).toBeUndefined();
    expect(payload.error).toBeUndefined();
  });

  test('成功且无输出：true', async () => {
    const outcome = await bashTool.execute({ command: 'true' }, makeCtx());
    expect(outcome.ok).toBe(true);
    expect(outcome.forModel).toContain('无输出');
    expect(payloadOf(outcome).exitCode).toBe(0);
  });

  test('命令退出非零：回喂退出码与 stderr（正常错误即数据，非工具故障）', async () => {
    const outcome = await bashTool.execute(
      { command: 'echo oops >&2; exit 3' },
      makeCtx(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('退出码 3');
    expect(outcome.forModel).toContain('oops');
    expect(outcome.forModel).toContain('[stderr]');
    expect(outcome.forModel).toContain('不是工具故障');
    const payload = payloadOf(outcome);
    expect(payload.exitCode).toBe(3);
    expect(payload.stderr).toContain('oops');
    expect(payload.error).toBeUndefined(); // 非零退出不算工具层错误
  });

  test('stdout + stderr 合并展示：[stderr] 标记区分', async () => {
    const outcome = await bashTool.execute(
      { command: 'echo out1; echo err >&2; echo out2' },
      makeCtx(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.forModel).toContain('out1');
    expect(outcome.forModel).toContain('out2');
    expect(outcome.forModel).toContain('[stderr]');
    expect(outcome.forModel).toContain('err');
    const payload = payloadOf(outcome);
    expect(payload.stdout).toContain('out1');
    expect(payload.stderr).toContain('err');
  });

  test('超长输出：截断出声（省略行数明示）', async () => {
    const outcome = await bashTool.execute({ command: 'seq 1 600' }, makeCtx());
    expect(outcome.ok).toBe(true);
    expect(outcome.forModel).toContain('省略了');
    const payload = payloadOf(outcome);
    expect(payload.truncated?.truncated).toBe(true);
    expect(payload.truncated?.omittedLines).toBeGreaterThan(0);
    expect(outcome.truncated?.truncated).toBe(true);
  });

  test('cwd 生效（绝对路径）：pwd 输出等于目标目录', async () => {
    const target = mkdtempSync(join(tmpDir, 'sub-'));
    try {
      const outcome = await bashTool.execute(
        { command: 'pwd', cwd: target },
        makeCtx(),
      );
      expect(outcome.ok).toBe(true);
      // pwd 输出的是物理路径；与 realpath 比较，避免 /tmp 符号链接（如 macOS /tmp→/private/tmp）差异
      expect(payloadOf(outcome).stdout?.trim()).toBe(realpathSync(target));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test('cwd 相对路径相对 ctx.cwd 解析', async () => {
    const sub = join(tmpDir, 'rel');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'marker.txt'), 'x', 'utf8');
    const outcome = await bashTool.execute(
      { command: 'ls marker.txt', cwd: 'rel' },
      makeCtx(tmpDir),
    );
    expect(outcome.ok).toBe(true);
    expect(payloadOf(outcome).stdout).toContain('marker.txt');
  });

  test('cwd 不存在：spawn 失败，可诊断（含 cwd）', async () => {
    const missing = join(tmpDir, 'no-such-dir');
    const outcome = await bashTool.execute(
      { command: 'echo hi', cwd: missing },
      makeCtx(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('无法启动 shell');
    const payload = payloadOf(outcome);
    expect(payload.error).toBe('spawn_failed');
  });

  test('超时：sleep 超过 timeoutMs 被终止（进程组终止、可诊断）', async () => {
    const start = Date.now();
    const outcome = await bashTool.execute(
      { command: 'sleep 5', timeoutMs: 200 },
      makeCtx(),
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3_000); // 未等完整 5s
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('超时');
    expect(outcome.forModel).toContain('已终止整个进程组');
    const payload = payloadOf(outcome);
    expect(payload.error).toBe('timeout');
    expect(payload.timeoutMs).toBe(200);
  });

  test('abort：预置中断信号 → 中断结果（已终止进程组）', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx: ToolContext = { signal: controller.signal, cwd: tmpDir };
    const outcome = await bashTool.execute({ command: 'sleep 5' }, ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('被中断');
    expect(outcome.forModel).toContain('已终止整个进程组');
    const payload = payloadOf(outcome);
    expect(payload.error).toBe('interrupted');
  });

  test('abort：执行中收到中断信号也终止进程组并回喂', async () => {
    const controller = new AbortController();
    const promise = bashTool.execute(
      { command: 'sleep 5' },
      { signal: controller.signal, cwd: tmpDir },
    );
    // 给子进程一点启动时间，然后中断
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('被中断');
    expect(payloadOf(outcome).error).toBe('interrupted');
  });

  test('命令被信号终止：kill -9 $$ 回喂信号（非工具主动终止）', async () => {
    const outcome = await bashTool.execute(
      { command: 'kill -9 $$' },
      makeCtx(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('SIGKILL');
    const payload = payloadOf(outcome);
    expect(payload.error).toBe('killed_by_signal');
    expect(payload.signal).toBe('SIGKILL');
  });
});

describe('bashTool 内部错误注入', () => {
  test('spawn 失败注入：shell 不存在 → 可诊断错误', async () => {
    const tool = createBashTool({ shellPath: '/nonexistent/modou-bash' });
    const outcome = await tool.execute({ command: 'echo hi' }, makeCtx());
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('无法启动 shell');
    const payload = payloadOf(outcome);
    expect(payload.error).toBe('spawn_failed');
    expect(payload.errorCode).toBe('ENOENT');
  });
});

describe('bashTool 装配', () => {
  test('defaultWriteTools 注册 bash 且幂等', () => {
    const registry = defaultWriteTools();
    expect(registry.has('bash')).toBe(true);
    expect(registry.find('bash')).toBe(bashTool);
    const again = defaultWriteTools(registry);
    expect(again.size).toBe(7); // read / grep / glob / write / edit / bash / todo_write
    expect(again.find('bash')).toBe(bashTool);
  });

  test('经管线执行：tool_result 事件带 forModel / payload', async () => {
    const registry = new ToolRegistry().register(bashTool);
    const outcome = await runToolPipeline(
      { id: 'c1', name: 'bash', input: { command: 'echo via-pipeline' } },
      { registry, context: { cwd: tmpDir } },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.forModel).toContain('via-pipeline');
  });
});
