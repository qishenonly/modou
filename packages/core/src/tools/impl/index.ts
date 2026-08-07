import { ToolRegistry } from '../registry';
import { globTool } from './glob';
import { grepTool } from './grep';
import { readTool } from './read';

/**
 * 工具实现（design 002 第十二节 `tools/impl/{read,write,edit,grep,glob,bash}.ts`）。
 * 0.2.0 只读工具集：read（T-021）、grep / glob（T-022）。
 */
export * from './read';
export * from './grep';
export * from './glob';

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
