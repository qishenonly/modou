import { z } from 'zod';
import type { Tool } from './types';

/**
 * 工具注册表（design 002 5.1 ① Resolve 的数据源，0.16.0 MCP 工具同样注册到这里）。
 *
 * - 按名注册 / 查找 / 列出；同名注册是编程错误，直接抛错，防止静默覆盖；
 * - 持有 schema → JSON Schema 的转换结果（缓存），供系统提示词向模型声明工具
 *   （002 7.1 稳定前缀里的「工具定义」，T-023 系统提示词消费）。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly jsonSchemas = new Map<string, unknown>();

  /** 注册一个工具；同名注册抛错（工具名全局唯一）。 */
  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 "${tool.name}" 重复注册：工具名必须全局唯一`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 按名查找（① Resolve）。未命中返回 undefined。 */
  find(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 全部已注册工具（按注册顺序）。 */
  list(): readonly Tool[] {
    return [...this.tools.values()];
  }

  /** 全部工具名（用于「未知工具」错误里列可用项）。 */
  names(): readonly string[] {
    return [...this.tools.keys()];
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * schema → JSON Schema（zod 4 内置 z.toJSONSchema），结果缓存。
   * 工具声明了 `jsonSchema` 覆盖（0.16.0 MCP 注入）时直接返回原文——
   * 远程 server 声明的 inputSchema 是权威形态，不走 round-trip。
   * 未知工具抛错——这属于编程错误（调用前应先 find / has）。
   */
  toJsonSchema(name: string): unknown {
    const tool = this.find(name);
    if (tool === undefined) {
      throw new Error(`未知工具 "${name}"：无法生成 JSON Schema`);
    }
    const cached = this.jsonSchemas.get(name);
    if (cached !== undefined) return cached;
    const jsonSchema =
      tool.jsonSchema !== undefined
        ? tool.jsonSchema
        : z.toJSONSchema(tool.schema);
    this.jsonSchemas.set(name, jsonSchema);
    return jsonSchema;
  }
}
