/**
 * 计算器模块（技能触发评测 fixture：含一个真实 bug，供「审查本次改动」任务）。
 */
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

/** bug：除数超界判断写反（<= 0 才该拒绝，这里 < 0 放过了 0）。 */
export function divide(a: number, b: number): number {
  if (b < 0) throw new Error('除数不能为负数');
  return a / b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
