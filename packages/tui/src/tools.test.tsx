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

describe('ToolCallList（单行紧凑展示）', () => {
  afterAll(() => {
    cleanup();
  });

  test('单条：✓/✗/… 工具名 摘要 一行', () => {
    const list = renderList([editEntry()]);
    const frame = list.frame();
    expect(frame).toContain('✓ edit');
    expect(frame).toContain('Edit /a.ts');
    // 单行紧凑：不渲染参数区 / diff 区 / 列表页脚
    expect(frame).not.toContain('参数：');
    expect(frame).not.toContain('diff：');
    expect(frame).not.toContain('Ctrl+');
    list.unmount();
  });

  test('多条只显示最新一条（进行中旋转闪烁行）', () => {
    const list = renderList([
      editEntry(),
      {
        id: 'c2',
        name: 'bash',
        input: { command: 'make build' },
        status: 'pending',
      },
    ]);
    const frame = list.frame();
    // 只显示最后一条 bash（进行中 spinner），不列全部条目
    expect(frame).toContain('bash');
    expect(frame).toContain('make build');
    expect(frame).not.toContain('✓ edit');
    list.unmount();
  });

  test('标记：ok → ✓，!ok → ✗，进行中 → …', () => {
    const list = renderList([
      {
        id: 'f1',
        name: 'edit',
        input: { path: '/a.ts' },
        status: 'done',
        ok: false,
        summary: '失败',
      },
    ]);
    expect(list.frame()).toContain('✗ edit 失败');
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
