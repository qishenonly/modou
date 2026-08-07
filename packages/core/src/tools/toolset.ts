import { jsonSchema, tool, type JSONSchema7, type ToolSet } from 'ai';
import type { ToolRegistry } from './registry';

/**
 * ToolRegistry → AI SDK v7 ToolSet 转换。
 *
 * loop 调 provider.streamChat 时必须把工具定义传给模型（StreamChatInput.tools），
 * 否则真实模型看不到任何工具、永远发不出 tool_use（G-0.2.0 的关键缺口）。
 *
 * AI SDK v7 的 tool() 契约（@ai-sdk/provider-utils）：
 * - `tool({ description, inputSchema })`：description 是给模型看的工具说明；
 *   inputSchema 是 FlexibleSchema —— 这里用 `jsonSchema()` 包装注册表缓存的
 *   JSON Schema（zod 4 `z.toJSONSchema` 产物，registry.toJsonSchema 已缓存，
 *   转换零成本、同一 schema 每次产出一致）；
 * - 本层只声明工具（不带 execute）：执行统一由 loop → runToolPipeline 负责，
 *   ToolSet 允许 execute 缺省——模型只发 tool-call，SDK 不直接执行。
 *
 * 转换结果以注册表注册顺序为 key 顺序；每个工具名全局唯一（register 已保证）。
 */
export function toToolSet(registry: ToolRegistry): ToolSet {
  const toolSet: ToolSet = {};
  for (const registered of registry.list()) {
    toolSet[registered.name] = tool({
      description: registered.description,
      // registry.toJsonSchema 返回 unknown；zod 4 的 JSON Schema 产物与
      // JSONSchema7 结构兼容，此处断言只做类型收窄，不改变运行时值。
      inputSchema: jsonSchema(
        registry.toJsonSchema(registered.name) as JSONSchema7,
      ),
    });
  }
  return toolSet;
}
