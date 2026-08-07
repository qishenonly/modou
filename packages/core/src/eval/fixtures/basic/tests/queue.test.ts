import { describe, expect, test } from 'bun:test';
import { TaskQueue } from '../src/queue';

describe('TaskQueue', () => {
  test('FIFO：dequeue 返回最先入队的元素', () => {
    const queue = new TaskQueue<number>();
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    expect(queue.dequeue()).toBe(1);
  });

  test('peek 不移除元素', () => {
    const queue = new TaskQueue<string>();
    queue.enqueue('a');
    expect(queue.peek()).toBe('a');
    expect(queue.size).toBe(1);
  });
});
