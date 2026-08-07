/**
 * 字符串工具模块（评测 fixture）。
 *
 * `isPalindrome` 缺失，是「加功能」评测任务的落点。
 * 评测在临时目录复制运行，绝不原地修改。
 */

/** 反转字符串（正确实现，作为回归基线）。 */
export function reverseString(input: string): string {
  return input.split('').reverse().join('');
}
