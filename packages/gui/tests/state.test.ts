/**
 * 渲染进程状态规约测试（纯函数，离线）。
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

describe('guiReducer（渲染进程状态规约）', () => {
  test('user_submit：封存残留流式缓冲并追加用户消息', () => {
    const withBuffer = guiReducer(initialGuiState(), {
      type: 'user_submit',
      text: '新问题',
    });
    expect(withBuffer.history).toEqual([{ role: 'user', text: '新问题' }]);

    // 残留流式缓冲先封存
    const buffered = guiReducer(withBuffer, {
      type: 'envelope',
      envelope: envelope('text_delta', { delta: '一半' }),
    });
    const submitted = guiReducer(buffered, {
      type: 'user_submit',
      text: '打断并改问',
    });
    expect(submitted.history.map((m) => m.text)).toEqual([
      '新问题',
      '一半',
      '打断并改问',
    ]);
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
    expect(state.history).toEqual([{ role: 'assistant', text: '你好' }]);
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

  test('tool 事件规约出条目（call → progress → result）', () => {
    let state = initialGuiState();
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('tool_call', {
        id: 't1',
        name: 'bash',
        input: { command: 'ls' },
      }),
    });
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('tool_progress', { id: 't1', text: 'running…' }),
    });
    state = guiReducer(state, {
      type: 'envelope',
      envelope: envelope('tool_result', {
        id: 't1',
        ok: true,
        summary: 'a.txt',
      }),
    });
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({
      id: 't1',
      name: 'bash',
      status: 'done',
      ok: true,
      summary: 'a.txt',
    });
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

  test('seed_thread 整体替换历史；set_totals 校准累计', () => {
    let state = guiReducer(initialGuiState(), {
      type: 'seed_thread',
      messages: [
        { role: 'user', text: '旧问题' },
        { role: 'assistant', text: '旧回答' },
      ],
    });
    expect(state.history).toHaveLength(2);
    expect(state.history[0].text).toBe('旧问题');

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
});
