/**
 * MCP 工具注入（T-162）：MCP server 的工具 → 内部 Tool，loop 视角与内置工具
 * 无差别（design 002 5.1 ①–⑧ 同管线）。
 *
 * 要点：
 * - **命名空间隔离**：注册名 `mcp_<server>_<tool>`（MCP_TOOL_PREFIX + 脱敏后的
 *   server/tool 名），避免与内置工具及跨 server 冲突；构造处保证前缀，context/
 *   project.ts 的 /context 单列按前缀切分（T-163，两侧互为注释）；
 * - **schema 转换（JSON Schema → zod 或直接透传）**：参数校验 schema 用 zod v4
 *   的 z.fromJSONSchema（失败回落宽松对象 schema），模型看到的 JSON Schema 保留
 *   服务器 inputSchema 原文（Tool.jsonSchema 覆盖，registry.toJsonSchema 直通——
 *   round-trip 会丢 additionalProperties 等细节，0.16.0 起本地工具也可用）；
 * - **risk 归类**：缺省 `network`（远程副作用、效果未知——默认权限矩阵下需审批，
 *   read-only 沙箱拒绝），可按 server 配置覆盖（T-163 manager 装配）；
 * - **错误即数据（002 5.3）**：isError / 传输层失败（崩溃 / 超时 / 断开）一律
 *   归为 ToolOutcome{ok:false} 回喂模型自纠，不抛异常；工具级失败由调用方
 *   （manager）负责判定崩溃并调度重连。
 *
 * 目录边界：本模块单向消费 tools/types 与 tools/registry（MCP → 内部 Tool），
 * 不依赖 runtime / provider。
 */

import { z } from 'zod';
import type { ToolRegistry } from '../tools/registry';
import type { Tool, ToolContext, ToolOutcome, ToolRisk } from '../tools/types';
import type { McpClient } from './client';
import { MCP_TOOL_PREFIX, McpError, renderMcpContent } from './types';
import type { McpToolDescriptor } from './types';

/** 注入选项（manager 按 settings.json 的 server 配置装配）。 */
export interface McpToolInjectionOptions {
  /**
   * 工具风险归类（002 5.2 ToolRisk）：缺省 `network`——MCP 工具是远程/进程外
   * 副作用、效果未知，默认权限矩阵（workspace-write + on-request）下需审批，
   * read-only 沙箱拒绝；可按 server 配置覆盖为 read/write/exec 以贴合实际。
   */
  readonly risk?: ToolRisk;
}

/**
 * 构造 MCP 工具的注册名：`mcp_<server>_<tool>`。
 * server/tool 名脱敏为 [a-z0-9_]（转小写、非字母数字折叠为下划线、去首尾下划线），
 * 保证工具名可读、可进提示词 JSON Schema；空名回落 'tool'（防御）。
 */
export function mcpToolName(serverName: string, toolName: string): string {
  const sanitize = (value: string): string => {
    const cleaned = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return cleaned.length > 0 ? cleaned : 'tool';
  };
  return `${MCP_TOOL_PREFIX}${sanitize(serverName)}_${sanitize(toolName)}`;
}

/** 是否普通对象（JSON Schema / args 的结构守卫）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 归一为工具对模型的 JSON Schema（非对象 inputSchema 回落 `{type:'object'}`）。 */
function normalizeInputSchema(inputSchema: unknown): unknown {
  return isPlainObject(inputSchema) ? inputSchema : { type: 'object' };
}

/**
 * JSON Schema → 参数校验 zod schema。
 * 用 zod v4 的 z.fromJSONSchema（MCP 官方 SDK 同款转换方向）；转换失败（服务器
 * schema 用了 zod 不支持的构造）回落宽松对象校验——本地只做「必须是 JSON 对象」
 * 的最小约束，完整校验交给远程 server（错误即数据，服务器错误回喂模型自纠）。
 */
function schemaFromInputSchema(inputSchema: unknown): z.ZodType {
  if (isPlainObject(inputSchema)) {
    try {
      return z.fromJSONSchema(inputSchema);
    } catch {
      // 回落（见函数头注释）
    }
  }
  return z.record(z.string(), z.unknown());
}

/** 工具描述：服务器声明优先，缺省给明确占位（不静默）。 */
function toolDescription(
  serverName: string,
  descriptor: McpToolDescriptor,
): string {
  const description = descriptor.description?.trim();
  if (description !== undefined && description.length > 0) return description;
  return `调用 MCP 服务器 ${serverName} 的工具 ${descriptor.name}（服务器未提供描述）`;
}

/**
 * 把一条 MCP 工具描述转成内部 Tool。execute 经注入的 McpClient 转发到服务器
 * （tools/call），结果（成功 / isError / 传输层失败）一律归为 ToolOutcome。
 */
export function createMcpTool(
  serverName: string,
  descriptor: McpToolDescriptor,
  client: McpClient,
  options: McpToolInjectionOptions = {},
): Tool {
  const name = mcpToolName(serverName, descriptor.name);
  return {
    name,
    description: toolDescription(serverName, descriptor),
    schema: schemaFromInputSchema(descriptor.inputSchema),
    risk: options.risk ?? 'network',
    // 模型看到的 JSON Schema = 服务器 inputSchema 原文（registry.toJsonSchema 直通）
    jsonSchema: normalizeInputSchema(descriptor.inputSchema),
    execute: (args, ctx) =>
      executeMcpTool(client, serverName, descriptor.name, args, ctx),
  };
}

/**
 * 把一个 server 的全部工具注册进注册表，返回成功注册的注册名。
 * 命名冲突（同 server 工具脱敏后重名 / 与注册表既有工具同名）抛错——防静默覆盖，
 * 由调用方（manager）按 server 捕获并报告，不拖垮其他 server。
 */
export function registerMcpTools(
  registry: ToolRegistry,
  serverName: string,
  descriptors: readonly McpToolDescriptor[],
  client: McpClient,
  options: McpToolInjectionOptions = {},
): readonly string[] {
  const registered: string[] = [];
  for (const descriptor of descriptors) {
    const tool = createMcpTool(serverName, descriptor, client, options);
    if (registry.has(tool.name)) {
      throw new Error(
        `MCP 工具名冲突：服务器 ${serverName} 的工具 ${descriptor.name} 注册为 "${tool.name}"，` +
          `但该名称已被占用——请检查服务器工具名（跨 server 脱敏后不得重名），` +
          `或在 settings.json 用工具级过滤排除冲突项`,
      );
    }
    registry.register(tool);
    registered.push(tool.name);
  }
  return registered;
}

// ---------------------------------------------------------------------------
// 执行侧
// ---------------------------------------------------------------------------

/** 执行一次 MCP 工具调用（createMcpTool 的 execute 闭包）。 */
async function executeMcpTool(
  client: McpClient,
  serverName: string,
  remoteName: string,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  // 协作式取消：管线已中止时快速失败（不发起远程调用）
  if (ctx.signal?.aborted === true) {
    return {
      ok: false,
      forModel: `调用已被中断（MCP 服务器 ${serverName} 的工具 ${remoteName}）`,
    };
  }
  try {
    const result = await client.callTool(remoteName, args, {
      signal: ctx.signal,
    });
    const text = renderMcpContent(result.content);
    return {
      ok: !result.isError,
      forModel: text,
      summary: result.isError
        ? `MCP 工具失败（${serverName}.${remoteName}）`
        : `MCP 工具完成（${serverName}.${remoteName}）`,
    };
  } catch (caught) {
    // 传输层失败（崩溃 / 超时 / 断开）→ 错误即数据：可诊断文本回喂模型；
    // 崩溃判定与重连由 manager 负责（本工具不感知）
    return {
      ok: false,
      forModel: formatCallError(caught, serverName, remoteName),
    };
  }
}

/** 归一 MCP 调用失败为可诊断文本（区分协议错误与传输层失败）。 */
function formatCallError(
  caught: unknown,
  serverName: string,
  remoteName: string,
): string {
  const prefix = `MCP 工具调用失败（服务器 ${serverName} 的工具 ${remoteName}）：`;
  if (caught instanceof McpError) {
    return `${prefix}${caught.message}`;
  }
  if (caught instanceof Error) {
    return `${prefix}${caught.message}`;
  }
  return `${prefix}${String(caught)}`;
}
