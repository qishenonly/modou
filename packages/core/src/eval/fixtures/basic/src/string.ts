/**
 * 字符串工具模块（评测 fixture）。
 *
 * `isPalindrome` 与 `truncate` 缺失，是「加功能」评测任务的落点；
 * `capitalize` 故意留有 bug（对应「修 bug」评测任务）。
 * 评测在临时目录复制运行，绝不原地修改。
 */

/** 反转字符串（正确实现，作为回归基线）。 */
export function reverseString(input: string): string {
  return input.split('').reverse().join('');
}

/** 首字母大写（其余保持原样）。BUG：对整个字符串 toUpperCase（'hello' → 'HELLO'）。 */
export function capitalize(input: string): string {
  return input.toUpperCase();
}
