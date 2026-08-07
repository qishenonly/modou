import { afterAll, describe, expect, test } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import type { ResumeCandidate } from '@modou/core';
import { ResumePicker } from './resume';

// ---------------------------------------------------------------------------
// 测试替身：ResumeCandidate 构造
// ---------------------------------------------------------------------------

function candidate(
  sessionId: string,
  overrides: Partial<ResumeCandidate> = {},
): ResumeCandidate {
  return {
    projectHash: 'abc',
    sessionId,
    path: `/sessions/${sessionId}.jsonl`,
    firstTs: 1_700_000_000_000,
    lastTs: 1_700_000_100_000,
    maxSeq: 1,
    entryCount: 1,
    sizeBytes: 100,
    preview: '',
    ...overrides,
  };
}

describe('ResumePicker（T-061 /resume 会话选择器）', () => {
  afterAll(() => {
    cleanup();
  });

  test('渲染候选列表：会话 ID / 末条时间 / 条数 / 简要开头', async () => {
    const candidates = [
      candidate('20260807-100000-aaaaaa', {
        lastTs: 1_700_000_100_000,
        entryCount: 12,
        preview: '实现 /resume 功能',
      }),
      candidate('20260806-090000-bbbbbb', {
        lastTs: 1_700_000_000_000,
        entryCount: 3,
      }),
    ];
    const { lastFrame, unmount } = render(
      <ResumePicker
        candidates={candidates}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('已保存的会话（/resume）');
    expect(frame).toContain('20260807-100000-aaaaaa');
    expect(frame).toContain('12 条');
    expect(frame).toContain('实现 /resume 功能');
    expect(frame).toContain('20260806-090000-bbbbbb');
    expect(frame).toContain('3 条');
    unmount();
  });

  test('Enter 选择当前选中项（首项默认选中）', async () => {
    const candidates = [candidate('sess-a'), candidate('sess-b')];
    const selected: string[] = [];
    const { stdin, unmount } = render(
      <ResumePicker
        candidates={candidates}
        onSelect={(id) => selected.push(id)}
        onCancel={() => {}}
      />,
    );
    // Ink 的 useInput 在首次提交后的 effect 里才订阅 stdin，需等待就绪
    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write('\r');
    expect(selected).toEqual(['sess-a']);
    unmount();
  });

  test('↑/↓ 循环移动选中项，Enter 选择移动后的项', async () => {
    const candidates = [
      candidate('sess-a'),
      candidate('sess-b'),
      candidate('sess-c'),
    ];
    const selected: string[] = [];
    const { stdin, unmount } = render(
      <ResumePicker
        candidates={candidates}
        onSelect={(id) => selected.push(id)}
        onCancel={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    stdin.write('\x1b[B'); // ↓（候选 0 → 1）
    stdin.write('\x1b[B'); // ↓（候选 1 → 2）
    stdin.write('\r');
    expect(selected).toEqual(['sess-c']);

    stdin.write('\x1b[A'); // ↑（候选 2 → 1）
    stdin.write('\r');
    expect(selected).toEqual(['sess-c', 'sess-b']);
    unmount();
  });

  test('数字键直接选择对应会话（1-based）', async () => {
    const candidates = [candidate('sess-a'), candidate('sess-b')];
    const selected: string[] = [];
    const { stdin, unmount } = render(
      <ResumePicker
        candidates={candidates}
        onSelect={(id) => selected.push(id)}
        onCancel={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    stdin.write('2');
    expect(selected).toEqual(['sess-b']);
    unmount();
  });

  test('Esc 取消（onCancel）', async () => {
    const candidates = [candidate('sess-a')];
    let cancelled = 0;
    const { stdin, unmount } = render(
      <ResumePicker
        candidates={candidates}
        onSelect={() => {}}
        onCancel={() => (cancelled += 1)}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    stdin.write('\x1b');
    expect(cancelled).toBe(1);
    unmount();
  });
});
