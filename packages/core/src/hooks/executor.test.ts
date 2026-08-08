/**
 * 钩子执行器（T-141）离线测试。
 *
 * 覆盖：JSON 协议（stdin 输入正确投影 / stdout 输出按点校验）；超时降级（按
 * failBehavior）；崩溃降级（fail-open 放行 / fail-closed 拦截，PreToolUse 缺省
 * fail-closed）；非法输出降级；执行日志（JSONL 落盘 + 条目字段）；processHook
 * 经总线注册执行。
 *
 * 全部离线：临时目录写脚本，spawn 本机运行时可执行文件（process.execPath），
 * 不访问任何外部服务。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus } from './bus';
import { HookExecutionLog } from './log';
import {
  defaultFailBehavior,
  processHook,
  runHookProcess,
  type HookProcessSpec,
} from './executor';

// ---------------------------------------------------------------------------
// 测试辅助：临时目录 + 脚本
// ---------------------------------------------------------------------------

let dirCount = 0;
const tempDirs: string[] = [];

/** 建一个隔离的临时目录，afterEach 清理。 */
function makeTempDir(label: string): string {
  dirCount += 1;
  const dir = mkdtempSync(join(tmpdir(), `modou-hooks-${label}-${dirCount}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 写一个可运行的 hook 脚本（read 全部 stdin JSON → 按 body 产出 stdout JSON）。 */
function writeHookScript(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(
    file,
    [
      "let data = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => { data += c; });",
      "process.stdin.on('end', () => {",
      '  const input = JSON.parse(data);',
      body,
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  return file;
}

/** 多行 body 的便捷写法（逗号拼接为字符串）。 */
function bodyOf(...lines: string[]): string {
  return lines.join('\n');
}

/** 让脚本以 `node <script>` 运行的规格：command = process.execPath。 */
function specFor(
  script: string,
  extra: Partial<HookProcessSpec> = {},
): HookProcessSpec {
  return { command: process.execPath, args: [script], ...extra };
}

/** 运行一次钩子进程的便捷封装（省去手写 input）。 */
function runPreToolUse(
  script: string,
  options: {
    spec?: Partial<HookProcessSpec>;
    signal?: AbortSignal;
  } = {},
) {
  return runHookProcess(
    'PreToolUse',
    {
      v: 1,
      point: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'ls' },
    },
    specFor(script, options.spec),
    {
      hookId: 'test-hook',
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// JSON 协议
// ---------------------------------------------------------------------------

describe('执行器：JSON 协议', () => {
  test('stdin 输入完整投影（v/point/toolName/toolInput/cwd/sessionId），stdout 输出按点解析', async () => {
    const dir = makeTempDir('proto');
    const script = writeHookScript(
      dir,
      'echo-input.mjs',
      // 把收到的输入原样回显到 reason，供断言
      "  process.stdout.write(JSON.stringify({ decision: 'allow', reason: JSON.stringify(input) }));",
    );
    const invocation = await runHookProcess(
      'PreToolUse',
      {
        v: 1,
        point: 'PreToolUse',
        sessionId: 'sess-1',
        cwd: '/tmp/proj',
        toolName: 'bash',
        toolInput: { command: 'ls -la' },
      },
      specFor(script),
      { hookId: 'proto' },
    );
    expect(invocation.degraded).toBe(false);
    expect(invocation.result).toMatchObject({ decision: 'allow' });
    // reason 里应能读到完整输入投影（契约字段全量透传）
    const echoed = JSON.parse((invocation.result as { reason: string }).reason);
    expect(echoed).toMatchObject({
      v: 1,
      point: 'PreToolUse',
      sessionId: 'sess-1',
      cwd: '/tmp/proj',
      toolName: 'bash',
    });
    expect(echoed.toolInput).toEqual({ command: 'ls -la' });
  });

  test('非零退出 + 非法输出按 PreToolUse 缺省 fail-closed 降级拦截', async () => {
    const dir = makeTempDir('invalid');
    const script = writeHookScript(
      dir,
      'bad-output.mjs',
      '  process.stdout.write("not json");',
    );
    const invocation = await runPreToolUse(script);
    expect(invocation.degraded).toBe(true);
    expect(invocation.result).toMatchObject({ decision: 'deny' });
    expect(invocation.result.reason).toContain('fail-closed');
  });
});

// ---------------------------------------------------------------------------
// 超时
// ---------------------------------------------------------------------------

describe('执行器：超时', () => {
  test('超时按 failBehavior 降级，且进程组被终止', async () => {
    const dir = makeTempDir('timeout');
    const script = writeHookScript(
      dir,
      'sleep-forever.mjs',
      '  setTimeout(() => {}, 100_000);',
    );
    const started = Date.now();
    const invocation = await runPreToolUse(script, {
      spec: { timeoutMs: 80 },
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(invocation.degraded).toBe(true);
    expect(invocation.result.decision).toBe('deny'); // PreToolUse 缺省 fail-closed
    expect(invocation.result.reason).toContain('超时');
  });

  test('fail-open 超时降级为放行', async () => {
    const dir = makeTempDir('timeout-open');
    const script = writeHookScript(
      dir,
      'sleep-forever.mjs',
      '  setTimeout(() => {}, 100_000);',
    );
    const invocation = await runPreToolUse(script, {
      spec: { timeoutMs: 50, failBehavior: 'fail-open' },
    });
    expect(invocation.degraded).toBe(true);
    expect(invocation.result.decision).toBe('allow');
    expect(invocation.result.reason).toContain('fail-open');
  });
});

// ---------------------------------------------------------------------------
// 外部中断（abort 信号）
// ---------------------------------------------------------------------------

describe('执行器：外部中断（abort）', () => {
  test('abort 触发时终止进程组并按 failBehavior 降级（reason 说明中断）', async () => {
    const dir = makeTempDir('abort');
    const script = writeHookScript(
      dir,
      'sleep-forever.mjs',
      '  setTimeout(() => {}, 100_000);',
    );
    const controller = new AbortController();
    const pending = runPreToolUse(script, {
      spec: { failBehavior: 'fail-open' },
      signal: controller.signal,
    });
    // 等一小会确保钩子进程已 spawn（再 abort——终止整组）
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    const invocation = await pending;
    expect(invocation.degraded).toBe(true);
    expect(invocation.result.decision).toBe('allow'); // fail-open 降级放行
    expect(invocation.result.reason).toContain('abort');
    expect(invocation.result.reason).toContain('fail-open');
  });

  test('abort + PreToolUse 缺省 fail-closed → deny 拦截', async () => {
    const dir = makeTempDir('abort-closed');
    const script = writeHookScript(
      dir,
      'sleep-forever.mjs',
      '  setTimeout(() => {}, 100_000);',
    );
    const controller = new AbortController();
    const pending = runPreToolUse(script, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    const invocation = await pending;
    expect(invocation.degraded).toBe(true);
    expect(invocation.result.decision).toBe('deny');
    expect(invocation.result.reason).toContain('abort');
  });

  test('abort 信号经 HookBus.run 注入 → processHook 透传 → 降级', async () => {
    const dir = makeTempDir('bus-abort');
    const script = writeHookScript(
      dir,
      'sleep-forever.mjs',
      '  setTimeout(() => {}, 100_000);',
    );
    const bus = new HookBus();
    bus.register(
      'PreToolUse',
      processHook(specFor(script), { hookId: 'abortable' }),
      { id: 'abortable' },
    );
    const controller = new AbortController();
    const pending = bus.run(
      'PreToolUse',
      { point: 'PreToolUse', toolName: 'bash', toolInput: { command: 'ls' } },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    const outcomes = await pending;
    expect(outcomes).toHaveLength(1);
    // PreToolUse 缺省 fail-closed → deny；reason 点名中断
    expect(outcomes[0].result).toMatchObject({ decision: 'deny' });
    expect(outcomes[0].result?.reason).toContain('abort');
  });
});

// ---------------------------------------------------------------------------
// 崩溃降级（fail-open / fail-closed）
// ---------------------------------------------------------------------------

describe('执行器：崩溃降级', () => {
  test('崩溃 + fail-closed（显式）→ deny 拦截', async () => {
    const dir = makeTempDir('crash-closed');
    const script = writeHookScript(dir, 'crash.mjs', '  process.exit(1);');
    const invocation = await runPreToolUse(script, {
      spec: { failBehavior: 'fail-closed' },
    });
    expect(invocation.degraded).toBe(true);
    expect(invocation.result.decision).toBe('deny');
  });

  test('崩溃 + fail-open → allow 放行（格式化钩子不拖死任务）', async () => {
    const dir = makeTempDir('crash-open');
    const script = writeHookScript(dir, 'crash.mjs', '  process.exit(1);');
    const invocation = await runPreToolUse(script, {
      spec: { failBehavior: 'fail-open' },
    });
    expect(invocation.degraded).toBe(true);
    expect(invocation.result.decision).toBe('allow');
  });

  test('defaultFailBehavior：PreToolUse fail-closed，其余点 fail-open', () => {
    expect(defaultFailBehavior('PreToolUse')).toBe('fail-closed');
    expect(defaultFailBehavior('PostToolUse')).toBe('fail-open');
    expect(defaultFailBehavior('UserPromptSubmit')).toBe('fail-open');
    expect(defaultFailBehavior('SessionStart')).toBe('fail-open');
  });

  test('UserPromptSubmit 崩溃缺省 fail-open → 不阻止提交（degraded 记录）', async () => {
    const dir = makeTempDir('prompt-crash');
    const script = writeHookScript(dir, 'crash.mjs', '  process.exit(1);');
    const invocation = await runHookProcess(
      'UserPromptSubmit',
      { v: 1, point: 'UserPromptSubmit', prompt: 'hello' },
      specFor(script),
      { hookId: 'prompt' },
    );
    expect(invocation.degraded).toBe(true);
    expect(invocation.result).toMatchObject({ decision: 'allow' });
  });

  test('SessionStart 显式 fail-closed 崩溃 → block', async () => {
    const dir = makeTempDir('start-block');
    const script = writeHookScript(dir, 'crash.mjs', '  process.exit(1);');
    const invocation = await runHookProcess(
      'SessionStart',
      { v: 1, point: 'SessionStart' },
      specFor(script, { failBehavior: 'fail-closed' }),
      { hookId: 'start' },
    );
    expect(invocation.degraded).toBe(true);
    expect(invocation.result).toMatchObject({ decision: 'block' });
  });
});

// ---------------------------------------------------------------------------
// 执行日志
// ---------------------------------------------------------------------------

describe('执行器：执行日志', () => {
  test('成功与降级各落一条 JSONL，字段齐全（point/hookId/command/decision/degraded）', async () => {
    const dir = makeTempDir('log');
    const log = new HookExecutionLog({ dir });
    const okScript = writeHookScript(
      dir,
      'ok.mjs',
      "  process.stdout.write(JSON.stringify({ decision: 'allow', reason: 'fine' }));",
    );
    const crashScript = writeHookScript(dir, 'crash.mjs', '  process.exit(3);');

    await runHookProcess(
      'PreToolUse',
      {
        v: 1,
        point: 'PreToolUse',
        toolName: 'edit',
        toolInput: { path: 'a.ts' },
      },
      specFor(okScript),
      { hookId: 'ok-hook', log },
    );
    await runHookProcess(
      'PreToolUse',
      {
        v: 1,
        point: 'PreToolUse',
        toolName: 'bash',
        toolInput: { command: 'rm -rf /' },
      },
      specFor(crashScript),
      { hookId: 'crash-hook', log },
    );
    await log.flush();

    const lines = readFileSync(log.path, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);

    expect(lines[0]).toMatchObject({
      type: 'hook',
      point: 'PreToolUse',
      hookId: 'ok-hook',
      command: expect.stringContaining('ok.mjs'),
      toolName: 'edit',
      decision: 'allow',
      degraded: false,
      reason: 'fine',
    });
    expect(typeof lines[0].ts).toBe('number');
    expect(lines[0].durationMs).toBeGreaterThanOrEqual(0);

    expect(lines[1]).toMatchObject({
      point: 'PreToolUse',
      hookId: 'crash-hook',
      toolName: 'bash',
      decision: 'deny',
      degraded: true,
      exitCode: 3,
    });
    expect(lines[1].reason).toContain('fail-closed');
  });

  test('写失败经 onError 上报，不抛出（日志是旁路）', async () => {
    const dir = makeTempDir('log-error');
    let reported: unknown;
    const log = new HookExecutionLog({
      dir,
      onError: (error) => {
        reported = error;
      },
    });
    // 构造已建目录；删掉目录后 append 必然写失败 → 走 onError，不抛出
    rmSync(dir, { recursive: true, force: true });
    await log.append({
      type: 'hook',
      point: 'PreToolUse',
      hookId: 'x',
      command: 'echo',
      durationMs: 1,
      decision: 'allow',
      degraded: false,
    });
    expect(reported).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// processHook：经总线注册执行
// ---------------------------------------------------------------------------

describe('执行器：processHook 经总线', () => {
  test('注册到 HookBus 后按匹配器执行，deny 结果随 outcome 返回', async () => {
    const dir = makeTempDir('bus');
    const script = writeHookScript(
      dir,
      'deny-dangerous.mjs',
      bodyOf(
        "  const cmd = input.toolInput?.command ?? '';",
        '  const dangerous = /rm\\s+-rf/.test(cmd);',
        "  process.stdout.write(JSON.stringify({ decision: dangerous ? 'deny' : 'allow', reason: dangerous ? '危险命令' : 'ok' }));",
      ),
    );
    const bus = new HookBus();
    bus.register(
      'PreToolUse',
      processHook(specFor(script), { hookId: 'guard' }),
      { id: 'guard', matcher: { tools: ['bash'] } },
    );

    const blocked = await bus.run('PreToolUse', {
      point: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'rm -rf /' },
    });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].result).toMatchObject({
      decision: 'deny',
      reason: '危险命令',
    });

    const allowed = await bus.run('PreToolUse', {
      point: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'ls' },
    });
    expect(allowed[0].result).toMatchObject({ decision: 'allow' });

    // 不命中匹配器（edit）→ 空批次
    const onEdit = await bus.run('PreToolUse', {
      point: 'PreToolUse',
      toolName: 'edit',
    });
    expect(onEdit).toHaveLength(0);
  });

  test('UserPromptSubmit 进程钩子注入附加上下文', async () => {
    const dir = makeTempDir('inject');
    const script = writeHookScript(
      dir,
      'inject.mjs',
      "  process.stdout.write(JSON.stringify({ decision: 'allow', additionalContext: '-- 项目事实：使用 Bun + TypeScript' }));",
    );
    const bus = new HookBus();
    bus.register(
      'UserPromptSubmit',
      processHook(specFor(script), { hookId: 'inject' }),
      { id: 'inject' },
    );
    const outcomes = await bus.run('UserPromptSubmit', {
      point: 'UserPromptSubmit',
      prompt: '帮我写个测试',
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result).toMatchObject({
      decision: 'allow',
      additionalContext: '-- 项目事实：使用 Bun + TypeScript',
    });
  });
});
