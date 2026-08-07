import type { Envelope } from '@modou/core';

/**
 * 事件通道：把 core「回调式」的事件产出（runAgentTurnStreaming 的 onEnvelope）
 * 适配成 App 可消费的 `AsyncIterable<Envelope>`。
 *
 * 为什么需要它：core 的流式桥接是 push 风格（回调逐条送出信封），而 App 组件
 * 是 pull 风格（for-await 逐条消费）。createEventChannel 用一个内部队列 + 等待者
 * 列表把两者接起来：push 唤醒等待中的消费者，yield 端按 FIFO 吐信封。
 *
 * 生命周期：一次 runTui 创建一条通道、长期持有，多轮 turn 复用同一事件流
 * （App 的 for-await 不会因单轮结束而退出）；退出时调用 end() 让消费端干净结束。
 * end() 可重复调用（幂等），退出后 push 的信封直接丢弃。
 */
export interface EventChannel {
  /** App 消费的事件流（一次创建、长期持有）。 */
  readonly stream: AsyncIterable<Envelope>;
  /** 推送一条信封（唤醒等待中的消费端）。 */
  push(envelope: Envelope): void;
  /** 结束流：App 的 for-await 得到 done 后退出（幂等）。 */
  end(): void;
}

/** 创建一条事件通道（见 EventChannel 注释）。 */
export function createEventChannel(): EventChannel {
  const queue: Envelope[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;

  const wake = (): void => {
    const pending = waiters.splice(0);
    for (const resolve of pending) resolve();
  };

  const stream = (async function* () {
    while (true) {
      if (queue.length > 0) {
        const envelope = queue.shift();
        if (envelope !== undefined) yield envelope;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
  })();

  return {
    stream,
    push(envelope) {
      // end 之后到达的信封直接丢弃（退出收尾：不再需要渲染剩余事件）
      if (ended) return;
      queue.push(envelope);
      wake();
    },
    end() {
      ended = true;
      wake();
    },
  };
}
