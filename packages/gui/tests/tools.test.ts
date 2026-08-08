/**
 * 工具规约 / diff 计算测试（纯函数移植自 TUI tools.tsx，口径必须一致）。
 */
import { describe, expect, test } from 'bun:test';
import {
  buildDiffLines,
  diffFromPayload,
  reduceToolEvent,
  summarizeEntry,
  summarizeInput,
} from '../src/lib/tools';

describe('reduceToolEvent（工具事件规约）', () => {
  test('tool_call → pending；tool_progress → running；tool_result → done', () => {
    let entries = reduceToolEvent([], {
      type: 'tool_call',
      data: { id: 't1', name: 'read', input: { path: 'a.ts' } },
    });
    expect(entries[0].status).toBe('pending');

    entries = reduceToolEvent(entries, {
      type: 'tool_progress',
      data: { id: 't1', text: '读文件中' },
    });
    expect(entries[0].status).toBe('running');
    expect(entries[0].progress).toBe('读文件中');

    entries = reduceToolEvent(entries, {
      type: 'tool_result',
      data: {
        id: 't1',
        ok: true,
        summary: 'a.ts',
        forModel: 'export const a = 1;',
      },
    });
    expect(entries[0].status).toBe('done');
    expect(entries[0].ok).toBe(true);
    expect(entries[0].forModel).toContain('export const a');
  });

  test('tool_result 先到（防御）也能兜底建条目', () => {
    const entries = reduceToolEvent([], {
      type: 'tool_result',
      data: { id: 'x', ok: false, summary: '失败' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('done');
    expect(entries[0].name).toBe('工具');
  });
});

describe('buildDiffLines / diffFromPayload（Edit diff 展示）', () => {
  test('公共前缀/后缀为 context，中间删除 + 添加', () => {
    const lines = buildDiffLines('a\nb\nold\nc', 'a\nb\nnew\nc');
    expect(lines.map((line) => line.kind)).toEqual([
      'context',
      'context',
      'remove',
      'add',
      'context',
    ]);
    expect(lines[2].text).toBe('old');
    expect(lines[3].text).toBe('new');
  });

  test('单处替换无公共行时：全删全加', () => {
    const lines = buildDiffLines('old', 'new');
    expect(lines.map((line) => line.kind)).toEqual(['remove', 'add']);
  });

  test('diffFromPayload：old_string/new_string 与嵌套 diff 都能探测', () => {
    const flat = diffFromPayload({
      path: 'a.ts',
      old_string: 'x',
      new_string: 'y',
    });
    expect(flat).not.toBeNull();
    expect(flat?.[0].kind).toBe('remove');

    const nested = diffFromPayload({ diff: { oldText: 'x', newText: 'y' } });
    expect(nested).not.toBeNull();

    const other = diffFromPayload({ stdout: 'ls 输出' });
    expect(other).toBeNull();
  });
});

describe('摘要（折叠行文本）', () => {
  test('summarizeInput 按关键参数键取摘要', () => {
    expect(summarizeInput('bash', { command: 'git status' })).toBe(
      'git status',
    );
    expect(summarizeInput('edit', { path: 'src/a.ts', content: 'x' })).toBe(
      'src/a.ts',
    );
  });

  test('summarizeEntry 优先 summary，缺省取 forModel 首行', () => {
    expect(
      summarizeEntry({
        id: 't1',
        name: 'bash',
        input: {},
        status: 'done',
        ok: true,
        summary: '成功',
      }),
    ).toBe('成功');
    expect(
      summarizeEntry({
        id: 't1',
        name: 'bash',
        input: {},
        status: 'done',
        ok: true,
        forModel: '\n\n第一行\n第二行',
      }),
    ).toBe('第一行');
  });
});
