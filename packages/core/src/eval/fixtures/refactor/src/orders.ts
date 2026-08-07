/**
 * 订单模块（重构评测 fixture）。
 *
 * `summary` 与 `audit` 重复了「字段挑选：id / total / status」的逻辑
 * （两处各写一遍三字段挑选），是「重构（行为不变断言）」评测任务的落点：
 * 应把三字段挑选抽取为共享函数（如 `pickOrderFields`），
 * 但 `summary` / `audit` 的对外行为必须保持不变。
 * 评测在临时目录复制运行，绝不原地修改。
 */

/** 订单。 */
export interface Order {
  readonly id: string;
  readonly total: number;
  readonly status: string;
  readonly reviewer?: string;
}

/** 精简视图：id / total / status。 */
export function summary(order: Order): {
  readonly id: string;
  readonly total: number;
  readonly status: string;
} {
  return { id: order.id, total: order.total, status: order.status };
}

/** 审计视图：全部字段。 */
export function audit(order: Order): Order {
  return {
    id: order.id,
    total: order.total,
    status: order.status,
    reviewer: order.reviewer,
  };
}
