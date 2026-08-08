/**
 * HookBus（T-140 生命周期总线）离线测试。
 *
 * 覆盖：注册 / 执行；串行顺序（注册顺序逐个 await）；并发执行（结果仍按注册
 * 顺序）；工具匹配器过滤（命中 / 不命中 / '*' / 缺省）；重复 ID 抛错；钩子
 * 崩溃不中断批次（outcome.error 记录）。
 *
 * 全部离线：内联钩子函数，不 spawn 任何进程。
 */
import { describe, expect, test } from 'bun:test';
import { HookBus } from './bus';
import { matchesTool } from './bus';
import type { HookContext } from './types';

/** 记录调用顺序的钩子工厂。 */
function trackingHook(record: string[], mark: string) {
  return async (): Promise<{ decision: 'continue'; reason: string }> => {
    record.push(mark);
    return { decision: 'continue', reason: mark };
  };
}

// ---------------------------------------------------------------------------
// 注册 / 执行
// ---------------------------------------------------------------------------

describe('HookBus：注册与执行', () => {
  test('注册后按钩子点执行，缺省串行保持注册顺序', async () => {
    const bus = new HookBus();
    const order: string[] = [];
    bus.register('PreToolUse', trackingHook(order, 'a'));
    bus.register('PreToolUse', trackingHook(order, 'b'));
    bus.register('PostToolUse', trackingHook(order, 'c'));

    const pre = await bus.run('PreToolUse', { point: 'PreToolUse' });
    expect(pre.map((o) => o.registration.id)).toEqual(['hook-1', 'hook-2']);
    expect(order).toEqual(['a', 'b']); // 串行：严格注册顺序
    expect(pre.every((o) => o.result?.decision === 'continue')).toBe(true);

    const post = await bus.run('PostToolUse', { point: 'PostToolUse' });
    expect(post.map((o) => o.registration.id)).toEqual(['hook-3']);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('无注册的钩子点返回空数组', async () => {
    const bus = new HookBus();
    expect(await bus.run('SessionStart', { point: 'SessionStart' })).toEqual(
      [],
    );
    expect(bus.has('SessionStart')).toBe(false);
    expect(bus.list()).toEqual([]);
  });

  test('重复 ID 抛错（防静默覆盖）', () => {
    const bus = new HookBus();
    bus.register('PreToolUse', async () => ({ decision: 'allow' }), {
      id: 'mine',
    });
    expect(() =>
      bus.register('PreToolUse', async () => ({ decision: 'deny' }), {
        id: 'mine',
      }),
    ).toThrow(/重复注册/);
  });
});

// ---------------------------------------------------------------------------
// 并发度
// ---------------------------------------------------------------------------

describe('HookBus：串行与并发', () => {
  test('concurrent 并发执行，结果仍按注册顺序返回', async () => {
    const bus = new HookBus();
    const order: string[] = [];
    // 三个钩子各自延迟不同，乱序完成；结果必须仍按注册顺序
    bus.register(
      'PreToolUse',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push('slow');
        return { decision: 'allow' };
      },
      { id: 'slow' },
    );
    bus.register(
      'PreToolUse',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('fast');
        return { decision: 'allow' };
      },
      { id: 'fast' },
    );
    bus.register(
      'PreToolUse',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        order.push('mid');
        return { decision: 'allow' };
      },
      { id: 'mid' },
    );

    const started = Date.now();
    const outcomes = await bus.run(
      'PreToolUse',
      { point: 'PreToolUse' },
      { concurrency: 'concurrent' },
    );
    const elapsed = Date.now() - started;
    // 并发：总耗时 ≈ 最慢者（30ms），而非 30+5+15=50ms
    expect(elapsed).toBeLessThan(50);
    expect(outcomes.map((o) => o.registration.id)).toEqual([
      'slow',
      'fast',
      'mid',
    ]);
    expect(order).toEqual(['fast', 'mid', 'slow']); // 完成顺序与注册顺序无关
  });

  test('run 选项覆盖总线缺省（总线缺省串行，run 指定并发）', async () => {
    const bus = new HookBus(); // 缺省串行
    const order: string[] = [];
    bus.register(
      'PreToolUse',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('a');
        return { decision: 'allow' };
      },
      { id: 'a' },
    );
    bus.register(
      'PreToolUse',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        order.push('b');
        return { decision: 'allow' };
      },
      { id: 'b' },
    );
    await bus.run('PreToolUse', { point: 'PreToolUse' });
    expect(order).toEqual(['a', 'b']); // 缺省串行

    order.length = 0;
    await bus.run(
      'PreToolUse',
      { point: 'PreToolUse' },
      { concurrency: 'concurrent' },
    );
    expect(order).toEqual(['b', 'a']); // 显式并发
  });

  test('总线构造时可设缺省并发度', async () => {
    const bus = new HookBus({ concurrency: 'concurrent' });
    const order: string[] = [];
    bus.register(
      'PreToolUse',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('a');
        return { decision: 'allow' };
      },
      { id: 'a' },
    );
    bus.register(
      'PreToolUse',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        order.push('b');
        return { decision: 'allow' };
      },
      { id: 'b' },
    );
    await bus.run('PreToolUse', { point: 'PreToolUse' });
    expect(order).toEqual(['b', 'a']);
  });
});

// ---------------------------------------------------------------------------
// 工具匹配器
// ---------------------------------------------------------------------------

describe('HookBus：工具匹配器', () => {
  test('matcher.tools 白名单：命中的执行，不命中的跳过', async () => {
    const bus = new HookBus();
    const hits: string[] = [];
    bus.register(
      'PreToolUse',
      async (ctx: HookContext) => {
        hits.push(ctx.toolName ?? '');
        return { decision: 'allow' };
      },
      { id: 'bash-only', matcher: { tools: ['bash'] } },
    );

    const onBash = await bus.run('PreToolUse', {
      point: 'PreToolUse',
      toolName: 'bash',
    });
    expect(onBash).toHaveLength(1);

    const onEdit = await bus.run('PreToolUse', {
      point: 'PreToolUse',
      toolName: 'edit',
    });
    expect(onEdit).toHaveLength(0);
    expect(hits).toEqual(['bash']);
  });

  test("matcher.tools '*' 或缺省 = 匹配全部", async () => {
    const bus = new HookBus();
    const star: string[] = [];
    const all: string[] = [];
    bus.register(
      'PreToolUse',
      async (ctx: HookContext) => {
        star.push(ctx.toolName ?? '');
        return { decision: 'allow' };
      },
      { id: 'star', matcher: { tools: '*' } },
    );
    bus.register(
      'PreToolUse',
      async () => {
        all.push('hit');
        return { decision: 'allow' };
      },
      { id: 'no-matcher' },
    );
    const outcomes = await bus.run('PreToolUse', {
      point: 'PreToolUse',
      toolName: 'bash',
    });
    expect(outcomes).toHaveLength(2);
    expect(star).toEqual(['bash']);
    expect(all).toEqual(['hit']);
  });

  test('非工具点忽略 matcher（UserPromptSubmit 无 toolName 也执行）', async () => {
    const bus = new HookBus();
    let ran = 0;
    bus.register(
      'UserPromptSubmit',
      async () => {
        ran += 1;
        return { decision: 'allow' };
      },
      { id: 'prompt', matcher: { tools: ['bash'] } },
    );
    await bus.run('UserPromptSubmit', { point: 'UserPromptSubmit' });
    expect(ran).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 崩溃兜底
// ---------------------------------------------------------------------------

describe('HookBus：崩溃兜底', () => {
  test('钩子抛异常不中断批次，错误记入 outcome.error', async () => {
    const bus = new HookBus();
    const after: string[] = [];
    bus.register(
      'PreToolUse',
      async () => {
        throw new Error('boom');
      },
      { id: 'crash' },
    );
    bus.register(
      'PreToolUse',
      async () => {
        after.push('ran');
        return { decision: 'allow' };
      },
      { id: 'after' },
    );

    const outcomes = await bus.run('PreToolUse', { point: 'PreToolUse' });
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].error).toBeInstanceOf(Error);
    expect(outcomes[0].result).toBeUndefined();
    expect(outcomes[1].result).toEqual({ decision: 'allow' });
    expect(after).toEqual(['ran']); // 崩溃不拖死后续钩子
  });

  test('matchesTool 纯函数：缺省 / * / 白名单命中语义', () => {
    expect(matchesTool(undefined, 'bash')).toBe(true);
    expect(matchesTool({ tools: '*' }, 'bash')).toBe(true);
    expect(matchesTool({ tools: [] }, 'bash')).toBe(false);
    expect(matchesTool({ tools: ['edit', 'write'] }, 'edit')).toBe(true);
    expect(matchesTool({ tools: ['edit'] }, 'bash')).toBe(false);
    expect(matchesTool({ tools: ['edit'] }, undefined)).toBe(false);
  });
});
