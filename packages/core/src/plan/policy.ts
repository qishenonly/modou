/**
 * Plan Mode 策略（T-112，design 002 十节扩展点表：Plan Mode = Permission 切
 * read-only + 一个模式状态）。
 *
 * 核心机制：进入 Plan Mode 时工具白名单**按工具名**收窄为只读三件套
 * （read / grep / glob）——不按 risk 收窄（`todo_write` 的 risk 是 read，但
 * 语义上属于「执行」能力，不进入白名单）。模型只看到这三个工具、只读研究；
 * 写 / 执行工具从注册表拿掉后，即使模型（受训练数据影响）发出 write 调用，
 * 管线 Resolve 也命中不到，统一归一为「未知工具」拒绝——**拒绝 = 零文件改动
 * 由只读白名单天然保证**。
 *
 * 装配方式：调用方（TUI / 测试）持有完整工具注册表，进入 Plan Mode 时用
 * `planReadonlyRegistry` 派生只读注册表传给 loop；退出时切回完整注册表。
 * loop 本身不感知模式——白名单强制在「给模型看什么工具」这一层完成。
 *
 * 依赖方向：本模块依赖 tools（ToolRegistry）——tools 是白名单的单一来源。
 */

import { ToolRegistry } from '../tools/registry';

/** Plan Mode 的只读白名单（按工具名；见文件头注释为何不按 risk）。 */
export const PLAN_MODE_TOOL_NAMES: readonly string[] = ['read', 'grep', 'glob'];

/**
 * Plan Mode 的模型指令（system 提示词 extra）：要求模型只读研究后产出固定结构
 * 的五段计划。进入 Plan Mode 时拼进系统提示词；测试可直接断言该文案存在。
 */
export const PLAN_MODE_INSTRUCTION = `## 计划模式（Plan Mode）

你当前处于**计划模式**：只读研究、产出结构化计划，**不执行任何改动**。

可用工具：read / grep / glob（只读）。没有 write / edit / bash——不要尝试调用它们。

任务：充分研究现状后，输出一个**结构化实施计划**，固定包含以下五段（用 markdown 小节标题，或严格 JSON 对象均可）：

1. ## 目标：这次改动要达成的结果（一句话）；
2. ## 涉及文件：将改动 / 新增 / 移除的文件路径清单（逐条列出）；
3. ## 分步改动：按顺序执行的改动步骤（每一步可独立验证）；
4. ## 验证方式：改完后如何确认正确（测试 / 构建 / 手动核对）；
5. ## 风险点：实现过程中可能踩的坑与规避。

只输出计划本身，不要执行改动、不要写任何文件。计划会交给用户评审，批准后才进入执行模式。`;

/**
 * 从完整注册表派生 Plan Mode 的只读注册表：只保留白名单内的工具。
 * 白名单外已有同名工具的注册表不受影响（新建注册表，不修改入参）。
 */
export function planReadonlyRegistry(registry: ToolRegistry): ToolRegistry {
  const filtered = new ToolRegistry();
  for (const name of PLAN_MODE_TOOL_NAMES) {
    const tool = registry.find(name);
    if (tool !== undefined) filtered.register(tool);
  }
  return filtered;
}
