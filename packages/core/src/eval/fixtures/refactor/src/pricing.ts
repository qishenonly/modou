/**
 * 价格模块（重构评测 fixture）。
 *
 * `roundPrice` / `discountPrice` / `taxPrice` 三处重复了「金额四舍五入到分」
 * 的逻辑（各写一遍 `Math.round(x * 100) / 100`），是「重构（行为不变断言）」
 * 评测任务的落点：应抽取为共享函数（如 `roundToCents`），
 * 但三个函数的对外行为必须保持不变。评测在临时目录复制运行，绝不原地修改。
 */

/** 金额四舍五入到分。 */
export function roundPrice(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** 折后价（percent 为折扣百分比）。 */
export function discountPrice(price: number, percent: number): number {
  const discounted = price * (1 - percent / 100);
  return Math.round(discounted * 100) / 100;
}

/** 含税价（rate 为税率百分比）。 */
export function taxPrice(price: number, rate: number): number {
  const taxed = price * (1 + rate / 100);
  return Math.round(taxed * 100) / 100;
}
