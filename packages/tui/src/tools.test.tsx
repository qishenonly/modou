import { afterAll, describe, expect, test } from 'bun:test';
import { render, cleanup } from 'ink-testing-library';
import type { ReactElement } from 'react';
import type { ToolResultData } from '@modou/core';
import type { ToolCallEntry, ToolEvent } from './tools';
import {
  DiffView,
  ToolCallList,
  buildDiffLines,
  diffFromPayload,
  formatValue,
  reduceToolEvent,
  summarizeInput,
} from './tools';

// ---------------------------------------------------------------------------
// 测试说明
// ---------------------------------------------------------------------------
// - 纯函数（reduceToolEvent / buildDiffLines / diffFromPayload）直接断言数据；
// - 渲染层用 ink-testing-library：非 TTY 帧不含 ANSI 颜色（Ink 只对 TTY 上色），
//   所以 diff 的「删除红/添加绿」在 DiffLine 的 kind 层面断言，渲染层断言
//   `+`/`-` 前缀与文本进入输出帧；
// - 键盘（Ctrl+O 等）需等 useInput 订阅就绪再写入 stdin（同 app.test 的 flush）。
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 等 useInput 订阅就绪 / 渲染落地。 */
async function flush(): Promise<void> {
  await sleep(30);
  await sleep(30);
}

// ---------------------------------------------------------------------------
// 事件构造助手（与 app.test 同款信封无关：直接喂 reduceToolEvent 用的 ToolEvent）
// ---------------------------------------------------------------------------

function callEvent(id: string, name: string, input: unknown): ToolEvent {
  return { type: 'tool_call', data: { id, name, input } };
}

function progressEvent(id: string, text: string): ToolEvent {
  return { type: 'tool_progress', data: { id, text } };
}

function resultEvent(
  id: string,
  ok: boolean,
  summary: string,
  extra: Partial<ToolResultData> = {},
): ToolEvent {
  return {
    type: 'tool_result',
    data: { id, ok, summary, ...extra },
  };
}

// ---------------------------------------------------------------------------
// reduceToolEvent：工具调用创建 / 填充 / 组织
// ---------------------------------------------------------------------------

describe('reduceToolEvent（工具事件规约）', () => {
  test('tool_call 创建 pending 条目；tool_result 填充成功/摘要/forModel/payload', () => {
    let state: readonly ToolCallEntry[] = [];
    state = reduceToolEvent(state, callEvent('c1', 'edit', { path: '/a.ts' }));
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({
      id: 'c1',
      name: 'edit',
      input: { path: '/a.ts' },
      status: 'pending',
    });

    state = reduceToolEvent(
      state,
      resultEvent('c1', true, 'Edit /a.ts：替换 1 处', {
        forModel: '已替换 /a.ts',
        payload: {
          path: '/a.ts',
          replaced: true,
          occurrenceCount: 1,
          newBytes: 10,
          old_string: 'const a = 1;',
          new_string: 'const a = 2;',
        },
      }),
    );
    expect(state).toHaveLength(1);
    expect(state[0].status).toBe('done');
    expect(state[0].ok).toBe(true);
    expect(state[0].summary).toBe('Edit /a.ts：替换 1 处');
    expect(state[0].forModel).toBe('已替换 /a.ts');
    expect(state[0].payload).toMatchObject({ replaced: true });
  });

  test('tool_progress 标记 running 并记录进度文本', () => {
    let state: readonly ToolCallEntry[] = [];
    state = reduceToolEvent(state, callEvent('c1', 'bash', { command: 'ls' }));
    state = reduceToolEvent(state, progressEvent('c1', '…正在输出'));
    expect(state[0].status).toBe('running');
    expect(state[0].progress).toBe('…正在输出');
  });

  test('多工具调用按 callId 组织：保持到达顺序、各自归拢', () => {
    let state: readonly ToolCallEntry[] = [];
    state = reduceToolEvent(state, callEvent('c1', 'read', { path: '/a.ts' }));
    state = reduceToolEvent(state, callEvent('c2', 'edit', { path: '/b.ts' }));
    state = reduceToolEvent(
      state,
      resultEvent('c2', false, 'Edit 失败：未匹配'),
    );
    state = reduceToolEvent(state, resultEvent('c1', true, 'Read /a.ts'));

    expect(state.map((e) => e.id)).toEqual(['c1', 'c2']);
    expect(state[0]).toMatchObject({ id: 'c1', status: 'done', ok: true });
    expect(state[1]).toMatchObject({ id: 'c2', status: 'done', ok: false });
  });

  test('tool_result 先于 tool_call 到达（防御）：兜底创建条目不丢失结果', () => {
    let state: readonly ToolCallEntry[] = [];
    state = reduceToolEvent(state, resultEvent('c1', true, '兜底结果'));
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({ id: 'c1', status: 'done', ok: true });
  });

  test('重复 tool_call（同 callId）：只刷参数，不重复建条目', () => {
    let state: readonly ToolCallEntry[] = [];
    state = reduceToolEvent(state, callEvent('c1', 'edit', { path: '/a.ts' }));
    state = reduceToolEvent(
      state,
      resultEvent('c1', true, 'Edit /a.ts：替换 1 处'),
    );
    state = reduceToolEvent(state, callEvent('c1', 'edit', { path: '/b.ts' }));
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({
      id: 'c1',
      input: { path: '/b.ts' },
      status: 'done',
      ok: true,
    });
  });
});

// ---------------------------------------------------------------------------
// summarizeInput：折叠行的进行中参数摘要
// ---------------------------------------------------------------------------

describe('summarizeInput（关键参数摘要）', () => {
  test('bash 取 command；edit/write 取 path；grep 取 pattern', () => {
    expect(summarizeInput('bash', { command: 'ls -la' })).toBe('ls -la');
    expect(summarizeInput('edit', { path: '/src/a.ts' })).toBe('/src/a.ts');
    expect(summarizeInput('grep', { pattern: 'foo', path: './src' })).toBe(
      'foo',
    );
  });
  test('无关键参数时退化为紧凑 JSON 并截断', () => {
    const summary = summarizeInput('foo', { a: 1, b: 'x'.repeat(200) });
    expect(summary.length).toBeLessThanOrEqual(81);
    expect(summary.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildDiffLines / diffFromPayload：diff 高亮的数据基础
// ---------------------------------------------------------------------------

describe('buildDiffLines（diff 计算）', () => {
  test('单行替换：删除行 + 添加行', () => {
    expect(buildDiffLines('const a = 1;', 'const a = 2;')).toEqual([
      { kind: 'remove', text: 'const a = 1;' },
      { kind: 'add', text: 'const a = 2;' },
    ]);
  });

  test('多行替换：公共前缀/后缀保留为 context，中间删除/添加', () => {
    expect(
      buildDiffLines(
        'import x;\nconst a = 1;\nconst b = 2;\n// 尾行',
        'import x;\nconst a = 9;\nconst b = 2;\n// 尾行',
      ),
    ).toEqual([
      { kind: 'context', text: 'import x;' },
      { kind: 'remove', text: 'const a = 1;' },
      { kind: 'add', text: 'const a = 9;' },
      { kind: 'context', text: 'const b = 2;' },
      { kind: 'context', text: '// 尾行' },
    ]);
  });

  test('删除片段（new_string 为空）：只有删除行', () => {
    expect(buildDiffLines('foo\nbar', '')).toEqual([
      { kind: 'remove', text: 'foo' },
      { kind: 'remove', text: 'bar' },
    ]);
  });

  test('新增片段（old_string 为空）：只有添加行', () => {
    expect(buildDiffLines('', 'foo\nbar')).toEqual([
      { kind: 'add', text: 'foo' },
      { kind: 'add', text: 'bar' },
    ]);
  });

  test('完全相同：全部 context', () => {
    expect(buildDiffLines('a\nb', 'a\nb')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'context', text: 'b' },
    ]);
  });
});

describe('diffFromPayload（diff 结构探测）', () => {
  test('识别 Edit 成功 payload 的 old_string / new_string', () => {
    const lines = diffFromPayload({
      path: '/a.ts',
      replaced: true,
      occurrenceCount: 1,
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    });
    expect(lines).toEqual([
      { kind: 'remove', text: 'const a = 1;' },
      { kind: 'add', text: 'const a = 2;' },
    ]);
  });

  test('识别嵌套 diff 形状（oldText / newText）', () => {
    const lines = diffFromPayload({
      diff: { oldText: 'x', newText: 'y' },
    });
    expect(lines).toEqual([
      { kind: 'remove', text: 'x' },
      { kind: 'add', text: 'y' },
    ]);
  });

  test('非 diff payload（Bash 输出等）返回 null', () => {
    expect(diffFromPayload({ command: 'ls', exitCode: 0, stdout: 'a' })).toBe(
      null,
    );
    expect(diffFromPayload('plain')).toBe(null);
    expect(diffFromPayload(undefined)).toBe(null);
  });
});

describe('formatValue（通用文本展示）', () => {
  test('字符串原样、对象 JSON 美化、undefined 占位', () => {
    expect(formatValue('你好')).toBe('你好');
    expect(formatValue({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatValue(undefined)).toBe('（无输出）');
  });
});

// ---------------------------------------------------------------------------
// ToolCallList 渲染：折叠/展开、成功失败标记、diff 高亮
// ---------------------------------------------------------------------------

/** 渲染 ToolCallList 并返回 { frame, stdin, unmount }。 */
function renderList(entries: readonly ToolCallEntry[]): {
  readonly frame: () => string;
  readonly stdin: { write(data: string): void };
  readonly unmount: () => void;
} {
  const element: ReactElement = <ToolCallList entries={entries} />;
  const rendered = render(element);
  return {
    frame: () => rendered.lastFrame() ?? '',
    stdin: rendered.stdin,
    unmount: () => rendered.unmount(),
  };
}

/** 一条 Edit 成功条目（带 diff payload）。 */
function editEntry(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return {
    id: 'c1',
    name: 'edit',
    input: {
      path: '/a.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    },
    status: 'done',
    ok: true,
    summary: 'Edit /a.ts：替换 1 处',
    payload: {
      path: '/a.ts',
      replaced: true,
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    },
    ...overrides,
  };
}

describe('ToolCallList（渲染与交互）', () => {
  afterAll(() => {
    cleanup();
  });

  test('默认折叠为一行：✓/✗ 工具名 摘要', () => {
    const list = renderList([
      editEntry(),
      editEntry({
        id: 'c2',
        name: 'bash',
        ok: false,
        summary: '命令退出码 2',
        payload: { command: 'ls /nope', exitCode: 2 },
      }),
    ]);
    const frame = list.frame();
    expect(frame).toContain('✓ edit Edit /a.ts：替换 1 处');
    expect(frame).toContain('✗ bash 命令退出码 2');
    // 折叠态不显示参数与输出
    expect(frame).not.toContain('参数：');
    expect(frame).not.toContain('diff：');
    list.unmount();
  });

  test('成功失败标记：ok → ✓，!ok → ✗，进行中 → …', () => {
    const pending: ToolCallEntry = {
      id: 'p1',
      name: 'bash',
      input: { command: 'make build' },
      status: 'pending',
    };
    const list = renderList([
      editEntry(),
      pending,
      editEntry({ id: 'f1', ok: false, summary: '失败' }),
    ]);
    const frame = list.frame();
    expect(frame).toContain('✓ edit');
    expect(frame).toContain('… bash make build');
    expect(frame).toContain('✗ edit 失败');
    list.unmount();
  });

  test('键盘展开（Ctrl+O）：显示参数与 diff，删除行/添加行带 +/- 前缀', async () => {
    const list = renderList([editEntry()]);
    await flush();
    // 初始折叠：无 diff 内容
    expect(list.frame()).not.toContain('参数：');

    // Ctrl+O（0x0f）展开选中条目
    list.stdin.write('\x0f');
    await flush();
    const expanded = list.frame();
    expect(expanded).toContain('参数：');
    expect(expanded).toContain('diff：');
    expect(expanded).toContain('- const a = 1;');
    expect(expanded).toContain('+ const a = 2;');

    // 再按 Ctrl+O 折叠
    list.stdin.write('\x0f');
    await flush();
    expect(list.frame()).not.toContain('参数：');
    list.unmount();
  });

  test('键盘导航：Ctrl+N 移动选中，Ctrl+O 展开的是被选中的条目', async () => {
    const list = renderList([
      editEntry(),
      // 第二条是 bash：显式给出自己的 input，不带 diff payload
      {
        id: 'c2',
        name: 'bash',
        input: { command: 'make build' },
        status: 'done',
        ok: true,
        summary: 'Build 完成',
        forModel: 'build ok',
      },
    ]);
    await flush();
    // 初始选第一条；Ctrl+N 移动到第二条
    list.stdin.write('\x0e'); // Ctrl+N
    await flush();
    list.stdin.write('\x0f'); // Ctrl+O
    await flush();
    const frame = list.frame();
    // 展开的是第二条（bash），显示其 forModel 输出而非第一条的 diff
    expect(frame).toContain('输出：');
    expect(frame).toContain('build ok');
    expect(frame).not.toContain('diff：');
    list.unmount();
  });

  test('非 diff 工具按文本展示（forModel 优先于 payload）', async () => {
    const list = renderList([
      {
        id: 'c1',
        name: 'bash',
        input: { command: 'ls' },
        status: 'done',
        ok: true,
        summary: '列表',
        forModel: 'a.ts\nb.ts',
        payload: { command: 'ls', exitCode: 0, stdout: 'a.ts\nb.ts' },
      },
    ]);
    await flush();
    list.stdin.write('\x0f'); // 展开
    await flush();
    const frame = list.frame();
    expect(frame).toContain('参数：');
    expect(frame).toContain('输出：');
    expect(frame).toContain('a.ts');
    // 无 diff 结构 → 不出现 diff 区
    expect(frame).not.toContain('diff：');
    list.unmount();
  });
});

// ---------------------------------------------------------------------------
// DiffView：diff 行渲染（+/- 前缀与行数）
// ---------------------------------------------------------------------------

describe('DiffView（渲染）', () => {
  afterAll(() => {
    cleanup();
  });

  test('删除行 - 前缀、添加行 + 前缀、上下文行数完整', () => {
    const lines = buildDiffLines('a\nold\nc', 'a\nnew\nc');
    const { lastFrame, unmount } = render(<DiffView lines={lines} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('- old');
    expect(frame).toContain('+ new');
    expect(frame).toContain('a');
    expect(frame).toContain('c');
    unmount();
  });
});
