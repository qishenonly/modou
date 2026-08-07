import { describe, expect, test } from 'bun:test';
import type { Envelope, ProtocolEvent } from '@modou/core';
import { createEventChannel } from './stream';

// ---------------------------------------------------------------------------
// 事件通道是 App 消费 core 事件流的适配层：push（core 回调式产出）→
// AsyncIterable（App 的 for-await）。这里离线验证顺序 / 阻塞 / 结束语义。
// ---------------------------------------------------------------------------

let counter = 0;

function env(event: ProtocolEvent): Envelope {
  counter += 1;
  const turn =
    event.type === 'turn_start' || event.type === 'turn_end'
      ? event.data.turn
      : 0;
  return { v: 1, seq: counter, ts: 0, agent: 'main', turn, ...event };
}

/** 让微任务队列推进一拍的辅助（async generator 的 next() 是微任务链）。 */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createEventChannel（core 回调 → App AsyncIterable 适配）', () => {
  test('push 的信封按 FIFO 序被消费，end 后消费端干净退出', async () => {
    const { stream, push, end } = createEventChannel();
    const seen: string[] = [];

    const consume = (async () => {
      for await (const envelope of stream) {
        seen.push(envelope.type);
      }
      seen.push('__done__');
    })();

    push(env({ type: 'turn_start', data: { turn: 1 } }));
    push(env({ type: 'text_delta', data: { delta: 'a' } }));
    push(env({ type: 'turn_end', data: { turn: 1, termination: 'end_turn' } }));
    await tick();
    end();

    await consume;
    expect(seen).toEqual(['turn_start', 'text_delta', 'turn_end', '__done__']);
  });

  test('end 之前消费端阻塞在下一个信封（不会提前退出）', async () => {
    const { stream, end } = createEventChannel();
    let resolved = false;

    const consume = (async () => {
      for await (const envelope of stream) {
        void envelope;
      }
      resolved = true;
    })();

    await tick();
    expect(resolved).toBe(false);

    end();
    await consume;
    expect(resolved).toBe(true);
  });

  test('end 后 push 的信封被丢弃（幂等收尾）', async () => {
    const { stream, push, end } = createEventChannel();
    end();
    end(); // 幂等：重复调用不报错

    push(env({ type: 'notice', data: { level: 'info', text: '被丢弃' } }));
    const seen: string[] = [];
    for await (const envelope of stream) {
      seen.push(envelope.type);
    }
    expect(seen).toEqual([]);
  });
});
