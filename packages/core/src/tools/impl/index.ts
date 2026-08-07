import { ToolRegistry } from '../registry';
import { bashTool } from './bash';
import { editTool } from './edit';
import { globTool } from './glob';
import { grepTool } from './grep';
import { readTool } from './read';
import { writeTool } from './write';

/**
 * 工具实现（design 002 第十二节 `tools/impl/{read,write,edit,grep,glob,bash}.ts`）。
 * 0.2.0 只读工具集：read（T-021）、grep / glob（T-022）；
 * 0.3.0 写/执行工具集：write（T-030）、edit（T-031）、bash（T-032，ADR 0005）。
 */
export * from './read';
export * from './grep';
export * from './glob';
export * from './write';
export * from './edit';
export * from './bash';

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
 * 便捷装配：0.3.0 写/执行工具集（read / grep / glob / write / edit / bash）
 * 加入一个工具注册表。覆盖已有的 read/grep/glob 组件（与 defaultReadonlyTools
 * 同源）；传入已有注册表时幂等。缺省创建新注册表。
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
  ]) {
    if (!registry.has(tool.name)) registry.register(tool);
  }
  return registry;
}
