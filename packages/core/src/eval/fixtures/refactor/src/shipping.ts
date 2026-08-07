/**
 * 运费模块（重构评测 fixture）。
 *
 * `standardCost` 与 `expressCost` 重复了「重量档位 → 基础价 / 超重单价」的
 * 阶梯定价逻辑（`weightKg <= 1` / `weightKg <= 5` 两档阈值在两处各写一遍），
 * 是「重构（行为不变断言）」评测任务的落点：应把档位逻辑抽取为共享函数，
 * 但 `quote` 的对外行为必须保持不变。评测在临时目录复制运行，绝不原地修改。
 */

/** 标准运费：重量档位阶梯定价。 */
export function standardCost(weightKg: number): number {
  if (weightKg <= 1) return 10;
  if (weightKg <= 5) return 20;
  return 20 + (weightKg - 5) * 3;
}

/** 加急运费：重量档位阶梯定价。 */
export function expressCost(weightKg: number): number {
  if (weightKg <= 1) return 25;
  if (weightKg <= 5) return 40;
  return 40 + (weightKg - 5) * 5;
}

/** 运费报价：按是否加急委托给标准 / 加急定价。 */
export function quote(weightKg: number, express: boolean): number {
  return express ? expressCost(weightKg) : standardCost(weightKg);
}
