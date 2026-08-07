/**
 * 任务队列（评测 fixture）。
 *
 * 注意：`TaskQueue.dequeue` 故意留有 bug（后进先出，FIFO 语义应为先进先出），
 * 对应「修 bug」评测任务。评测在临时目录复制运行，绝不原地修改。
 */

/** 一个简单的 FIFO 任务队列。 */
export class TaskQueue<T> {
  private items: T[] = [];

  /** 入队：追加到队尾。 */
  enqueue(item: T): void {
    this.items.push(item);
  }

  /** 出队。BUG：用了 pop() 取队尾，FIFO 语义应取队头（shift()）。 */
  dequeue(): T | undefined {
    return this.items.pop();
  }

  /** 查看队头元素（不移除）；空队列返回 undefined。 */
  peek(): T | undefined {
    return this.items[0];
  }

  /** 当前队列长度。 */
  get size(): number {
    return this.items.length;
  }
}
