/**
 * 渲染进程状态规约测试（纯函数，离线）。
 * 时间线语义：工具调用内联在消息流中（ab 间调用的工具显示在 ab 与 c 之间）。
 */
import { describe, expect, test } from 'bun:test';
import type { Envelope } from '@modou/core';
import { guiReducer, initialGuiState } from '../src/lib/state';

function envelope(type: Envelope['type'], data: unknown, seq = 1): Envelope {
  return {
    v: 1,
    seq,
    ts: Date.now(),
    agent: 'main',
    turn: 1,
    type,
    data,
  } as Envelope;
}

function kinds(state: ReturnType<typeof guiReducer>): string[] {
  return state.timeline.map((entry) => entry.kind);
}

describe('guiReducer（渲染进程状态规约）', () => {
  test('user_submit：封存残留流式缓冲并追加用户消息', () => {
    const withBuffer = guiReducer(initialGuiState(), {
      type: 'user_submit',
      text: '新问题',
    });
    expect(kinds(withBuffer)).toEqual(['user']);

    // 残留流式缓冲先封存
    const buffered = guiReducer(withBuffer, {
      type: 'envelope',
      envelope: envelope('text_delta', { delta: '一半' }),
    });
    const submitted = guiReducer(buffered, {
      type: 'user_submit',
      text: '打断并改问',
    });
    expect(kinds(submitted)).toEqual(['user', 'assistant', 'user']);
    const texts = submitted.timeline
      .filter(
        (
          entry,
        ): entry is {
          readonly id: number;
          readonly kind: 'user' | 'assistant';
          readonly text: string;
        } => entry.kind !== 'tool',
      )
      .map((entry) => entry.text);
    expect(texts).toEqual(['新问题', '一半', '打断并改问']);
  });

  test('text_delta 累计、turn_end 封存为 assistant 消息', () => {
    let state = initialGuiState();
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('turn_start', { turn: 1 }),
    });
    expect(state.running).toBe(true);
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('text_delta', { delta: '你' }),
    });
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('text_delta', { delta: '好' }),
    });
    expect(state.streamingText).toBe('你好');
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('turn_end', { turn: 1, termination: 'end_turn' }),
    });
    expect(state.running).toBe(false);
    expect(state.streamingText).toBe('');
    expect(state.timeline).toEqual([
      { id: expect.any(Number), kind: 'assistant', text: '你好' },
    ]);
  });

  test('工具调用内联时间线：ab → 工具 → c（不堆在回复末尾）', () => {
    let state = initialGuiState();
    state = guiReducer(state, {
      type: 'user_submit',
      text: '改这个文件',
    });
    // a b
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('text_delta', { delta: 'a' }),
    });
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('text_delta', { delta: 'b' }),
    });
    // 工具调用发生在 ab 之间
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('tool_call', {
        id: 't1',
        name: 'edit',
        input: { path: 'a.txt', old_string: 'x', new_string: 'y' },
      }),
    });
    expect(kinds(state)).toEqual(['user', 'assistant', 'tool']);
    // 工具结果
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('tool_result', {
        id: 't1',
        ok: true,
        summary: '已修改',
      }),
    });
    // c
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('text_delta', { delta: 'c' }),
    });
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('turn_end', { turn: 1, termination: 'end_turn' }),
    });
    // 顺序：user → assistant(ab) → tool → assistant(c)
    expect(kinds(state)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(state.timeline[2]).toMatchObject({ kind: 'tool' });
    expect(state.timeline[3]).toMatchObject({ kind: 'assistant', text: 'c' });
    const toolEntry = state.timeline[2];
    if (toolEntry.kind === 'tool') {
      expect(toolEntry.entry).toMatchObject({
        id: 't1',
        name: 'edit',
        status: 'done',
        ok: true,
        summary: '已修改',
      });
    }
  });

  test('usage 逐次累加，缺省字段按 0 计', () => {
    let state = initialGuiState();
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('usage', { inputTokens: 100, outputTokens: 20 }),
    });
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('usage', { outputTokens: 5 }),
    });
    expect(state.totals.inputTokens).toBe(100);
    expect(state.totals.outputTokens).toBe(25);
  });

  test('approval_request 打开 / approval_resolved 关闭', () => {
    let state = initialGuiState();
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('approval_request', {
        id: 'a1',
        description: 'rm -rf /tmp/x',
        risk: 'exec',
        options: [],
      }),
    });
    expect(state.approval?.id).toBe('a1');
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('approval_resolved', {
        id: 'a1',
        decision: 'allow_once',
        source: 'user',
      }),
    });
    expect(state.approval).toBeNull();
  });

  test('compaction / notice 追加提示', () => {
    let state = initialGuiState();
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('compaction', {
        beforeTokens: 9000,
        afterTokens: 2000,
        coveredTurns: [1, 3],
      }),
    });
    expect(state.notices[0].text).toContain('9000 → 2000');
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('notice', { level: 'warn', text: '配置告警' }),
    });
    expect(state.notices[1].text).toBe('配置告警');
  });

  test('seed_thread 整体替换时间线；set_totals 校准累计', () => {
    let state = guiReducer(initialGuiState(), {
      type: 'seed_thread',
      messages: [
        { role: 'user', text: '旧问题' },
        { role: 'assistant', text: '旧回答' },
      ],
    });
    expect(state.timeline).toHaveLength(2);
    expect(kinds(state)).toEqual(['user', 'assistant']);

    state = guiReducer(state, {
      type: 'set_totals',
      totals: {
        inputTokens: 500,
        outputTokens: 60,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
    expect(state.totals.inputTokens).toBe(500);
  });

  test('remove_last_assistant 移除最后一条 assistant 回复', () => {
    let state = initialGuiState();
    state = guiReducer(state, { type: 'user_submit', text: 'Q' });
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('text_delta', { delta: 'A' }),
    });
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('turn_end', { turn: 1, termination: 'end_turn' }),
    });
    expect(state.timeline).toHaveLength(2);
    state = guiReducer(state, { type: 'remove_last_assistant' });
    expect(state.timeline).toHaveLength(1);
    expect(kinds(state)).toEqual(['user']);
  });
});
