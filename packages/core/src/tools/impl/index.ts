import { ToolRegistry } from '../registry';
import { bashTool } from './bash';
import { editTool } from './edit';
import { globTool } from './glob';
import { grepTool } from './grep';
import { readTool } from './read';
import { taskTool } from './task';
import { todoTool } from './todo';
import { writeTool } from './write';
import { createWebFetchTool, type WebFetchConfig } from './webfetch';
import { createWebSearchTool, type WebSearchConfig } from './websearch';

/**
 * 工具实现（design 002 第十二节 `tools/impl/{read,write,edit,grep,glob,bash}.ts`）。
 * 0.2.0 只读工具集：read（T-021）、grep / glob（T-022）；
 * 0.3.0 写/执行工具集：write（T-030）、edit（T-031）、bash（T-032，ADR 0005）；
 * 0.11.0 清单工具：todo_write（T-110，复用 SummaryState.todo 结构，ADR 0010）；
 * 0.12.0 子代理工具：task（T-120，supervisor 一层深，ADR 0011）；
 * 0.17.0 角色派发工具：agent（T-170，自定义 agents 复用子代理运行时）；
 * 0.17.0 联网工具：webfetch（T-171）/ websearch（T-172，risk: network，
 * 域名过滤 + 提示注入防护）。
 */
export * from './read';
export * from './grep';
export * from './glob';
export * from './write';
export * from './edit';
export * from './bash';
export * from './todo';
export * from './task';
export * from './skill';
export * from './agent';
export * from './webfetch';
export * from './websearch';

/**
 * 便捷装配：把全部只读工具（read / grep / glob）加入一个工具注册表
 * （T-023 系统提示词的工具集用它起步）。
 *
 * 与 read.ts 里的 defaultReadTools（只含 read，向后兼容）区分：本函数是
 * 0.2.0 只读工具集的完整装配。缺省创建新注册表；传入已有注册表时幂等
 * （已有同名的跳过，不重复注册）。
 */
export function defaultReadonlyTools(
  registry: ToolRegistry = new ToolRegistry(),
): ToolRegistry {
  for (const tool of [readTool, grepTool, globTool]) {
    if (!registry.has(tool.name)) registry.register(tool);
  }
  return registry;
}

/**
 * 便捷装配：写/执行工具集（read / grep / glob / write / edit / bash / todo_write / task）
 * 加入一个工具注册表。覆盖已有的 read/grep/glob 组件（与 defaultReadonlyTools
 * 同源）；传入已有注册表时幂等。缺省创建新注册表。
 *
 * 0.11.0 起含 todo_write（T-110）：清单工具无文件系统副作用（risk: read），
 * 但语义上属于「执行」能力，因此归入写/执行工具集而非只读集（Plan Mode 的
 * 只读白名单按工具名收窄为 read/grep/glob，todo_write 不会进入）。
 * 0.12.0 起含 task（T-120）：子代理派发工具，语义上是「执行」能力（子代理
 * 内部可有写/执行工具），同样归入写/执行工具集而非只读集。
 */
export function defaultWriteTools(
  registry: ToolRegistry = new ToolRegistry(),
): ToolRegistry {
  for (const tool of [
    readTool,
    grepTool,
    globTool,
    writeTool,
    editTool,
    bashTool,
    todoTool,
    taskTool,
  ]) {
    if (!registry.has(tool.name)) registry.register(tool);
  }
  return registry;
}

/**
 * 在既有工具集上追加联网工具（0.17.0 T-171 webfetch / T-172 websearch）：
 * 复制注册表 + 注册 WebFetch / WebSearch 工具（域名过滤配置随 settings.json
 * web 键传入；缺省不限制域名，联网默认需批准由权限模型 risk=network 兜底）。
 * 复制而非原地注册——不修改调用方传入的注册表（与 withSkillTool 同一约定）。
 */
export function withWebTools(
  registry: ToolRegistry,
  config?: WebFetchConfig & WebSearchConfig,
): ToolRegistry {
  const copy = new ToolRegistry();
  for (const tool of registry.list()) copy.register(tool);
  copy.register(createWebFetchTool({ config }));
  copy.register(createWebSearchTool({ config }));
  return copy;
}
