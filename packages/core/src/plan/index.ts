/**
 * 规划模块（T-112 Plan Mode / T-113 计划文档化，0.11.0「会规划」）。
 *
 * - plan.ts：结构化计划的类型 / 解析（JSON + markdown）/ 序列化（T-113 落盘）；
 * - policy.ts：Plan Mode 策略——只读白名单（read/grep/glob）+ 模型指令 +
 *   只读注册表派生（拒绝 = 零改动由白名单保证）。
 *
 * 依赖方向：plan/policy.ts 依赖 tools（白名单的单一来源）；plan.ts 零依赖。
 */
export * from './plan';
export * from './policy';
