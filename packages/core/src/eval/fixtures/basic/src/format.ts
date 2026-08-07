/**
 * 格式化工具模块（评测 fixture）。
 *
 * 注意：`camelToSnake` 与 `snakeToCamel` 故意留有 bug（对应「修 bug」评测
 * 任务）；`formatBytes` / `csvToJson` / `titleCase` 缺失，是「加功能」评测
 * 任务的落点。评测在临时目录复制运行，绝不原地修改。
 */

/** camelCase → snake_case。BUG：未把大写转小写（'myVar' → 'my_Var'）。 */
export function camelToSnake(input: string): string {
  return input.replace(/([A-Z])/g, '_$1');
}

/** snake_case → camelCase。BUG：替换后仍保留下划线（'my_var' → 'my_var' 而非 'myVar'）。 */
export function snakeToCamel(input: string): string {
  return input.replace(/_([a-z])/g, '_$1');
}
