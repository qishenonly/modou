import type { Envelope, ProtocolEvent } from './events';

/** EnvelopeEmitter 构造选项。 */
export interface EnvelopeEmitterOptions {
  /**
   * 发出者 ID。主代理固定 'main'（0.12.0 子代理带上自身 ID，
   * 前端按 agent 分组折叠，协议一个字节都不用改 —— 002 3.1 的便宜先手）。
   */
  readonly agent?: string;
  /** 起始轮次（默认 0；通常由 `turn_start` 事件推进）。 */
  readonly turn?: number;
  /** 时钟注入口（测试用）；默认 `Date.now`。 */
  readonly now?: () => number;
}

/**
 * EnvelopeEmitter：为一次运行维护信封的公共字段，把内部事件包成协议信封。
 *
 * - `seq`：单调递增，每次 `emit` +1（首条为 1），前端据此排序与去重；
 * - `turn`：由 `turn_start` / `turn_end` 事件同步，其余事件沿用当前轮次；
 * - `ts`：由注入口时钟给出（默认 `Date.now`），同一条链路上可重复；
 * - `agent`：构造时固定，主代理默认 'main'。
 */
export class EnvelopeEmitter {
  private sequence = 0;
  private currentTurn: number;
  private readonly emitterAgent: string;
  private readonly clock: () => number;

  constructor(options: EnvelopeEmitterOptions = {}) {
    this.emitterAgent = options.agent ?? 'main';
    this.currentTurn = options.turn ?? 0;
    this.clock = options.now ?? (() => Date.now());
  }

  /** 已发出的信封数（下一条 seq）。 */
  get seq(): number {
    return this.sequence;
  }

  /** 当前轮次。 */
  get turn(): number {
    return this.currentTurn;
  }

  /**
   * 把一条协议事件包成信封。轮次跟随 `turn_start` / `turn_end` 事件更新；
   * 其余事件（text_delta / usage / error…）使用当前轮次。
   */
  emit<TEvent extends ProtocolEvent>(event: TEvent): Envelope<TEvent> {
    if (event.type === 'turn_start' || event.type === 'turn_end') {
      this.currentTurn = (
        event as { data: { readonly turn: number } }
      ).data.turn;
    }
    this.sequence += 1;
    // 用展开把事件的 type/data 并入公共字段，让 TS 推断出
    // `公共字段 & TEvent` 的交叉类型，与 Envelope<TEvent> 同构。
    return {
      v: 1 as const,
      seq: this.sequence,
      ts: this.clock(),
      agent: this.emitterAgent,
      turn: this.currentTurn,
      ...event,
    };
  }
}
