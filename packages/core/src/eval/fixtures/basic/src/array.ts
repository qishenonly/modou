/**
 * 数组工具模块（评测 fixture）。
 *
 * `chunk` 故意留有 bug（余数块被丢弃），对应「修 bug」评测任务；
 * `unique` 缺失，是「加功能」评测任务的落点。
 * 评测在临时目录复制运行，绝不原地修改。
 */

/** 把数组按 chunkSize 切块。BUG：不足一组的余数块被丢弃（[1,2,3] 按 2 → [[1,2]] 少了 [3]）。 */
export function chunk<T>(items: readonly T[], chunkSize: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i + chunkSize <= items.length; i += chunkSize) {
    result.push(items.slice(i, i + chunkSize));
  }
  return result;
}
