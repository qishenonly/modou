/**
 * 数学工具模块（评测 fixture）。
 *
 * 注意：`average` 与 `fibonacci` 故意留有 bug（对应「修 bug」评测任务），
 * `isPrime` 是正确实现（回归基线）。评测在临时目录复制运行，绝不原地修改。
 */

/** 计算一组数值的平均值。BUG：除数用了 `length - 1`，应除以 `length`。 */
export function average(values: number[]): number {
  if (values.length === 0) return NaN;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / (values.length - 1);
}

/** 斐波那契数列第 n 项。BUG：基准条件在 n <= 1 时返回 1，应返回 n。 */
export function fibonacci(n: number): number {
  if (n <= 1) return 1;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

/** 判断一个数是否为质数（正确实现，作为回归基线）。 */
export function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i += 1) {
    if (n % i === 0) return false;
  }
  return true;
}
