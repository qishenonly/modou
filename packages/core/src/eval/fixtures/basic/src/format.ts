/**
 * 格式化工具模块（评测 fixture）。
 *
 * 注意：`camelToSnake` 故意留有 bug（只插了下划线没转小写），对应「修 bug」
 * 评测任务；`formatBytes` / `csvToJson` 缺失，是「加功能」评测任务的落点。
 * 评测在临时目录复制运行，绝不原地修改。
 */

/** camelCase → snake_case。BUG：未把大写转小写（'myVar' → 'my_Var'）。 */
export function camelToSnake(input: string): string {
  return input.replace(/([A-Z])/g, '_$1');
}
