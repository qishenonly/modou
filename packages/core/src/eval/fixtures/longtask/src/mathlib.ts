/**
 * 数学函数库（长任务评测 fixture，T-090）。
 *
 * 五个函数全部缺失实现（抛「未实现」）——评测任务要求逐一实现它们。
 * 该任务模拟一个 40+ 轮的长会话（离线测试用多轮用户历史 + 工具调用驱动，
 * 真实模型会读多个文件、跑测试多轮），并在会话中途触发上下文压缩
 * （T-070），验证「压缩后任务延续率」：压缩前后 `tests/final.test.ts`
 * 的判定都必须通过。评测在临时目录复制运行，绝不原地修改。
 */

/** 两数相加。缺失：应返回 a + b。 */
export function add(a: number, b: number): number {
  throw new Error(`未实现：add(${a}, ${b})`);
}

/** 两数相减。缺失：应返回 a - b。 */
export function subtract(a: number, b: number): number {
  throw new Error(`未实现：subtract(${a}, ${b})`);
}

/** 两数相乘。缺失：应返回 a * b。 */
export function multiply(a: number, b: number): number {
  throw new Error(`未实现：multiply(${a}, ${b})`);
}

/** 两数相除。缺失：应返回 a / b。 */
export function divide(a: number, b: number): number {
  throw new Error(`未实现：divide(${a}, ${b})`);
}

/** 取模。缺失：应返回 a % b。 */
export function modulo(a: number, b: number): number {
  throw new Error(`未实现：modulo(${a}, ${b})`);
}
