import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseAgentMarkdown, type CustomAgent } from './parse';

/**
 * 自定义 agents 发现与加载（0.17.0 T-170，design 002 十二节用户侧布局
 * `<project>/.modou/{settings.json,skills/,agents/,commands/}`）。
 *
 * 两级发现（与 Skills 同构但只有两层——agents 是项目内角色配置，没有内置层）：
 * - 全局 `~/.modou/agents/`（homeDir 注入，测试用临时目录隔离）——低优先级；
 * - 项目级 `<projectRoot>/.modou/agents/`——高优先级（同名覆盖全局）。
 *
 * 发现即加载：对每个 `*.md` 文件同步解析出 CustomAgent（frontmatter 缺
 * name/description/正文 = 解析失败 = 跳过并记录文件名，调用方发 notice 告知，
 * 不静默）。加载时**只解析不校验白名单**：allowedTools 里的工具名是否真实
 * 存在由派发时的注册表派生裁决（父代理没有的工具名静默跳过，权限继承不超父，
 * ADR 0011）——与 skill 的 allowed-tools、自定义命令的 allowedTools 同一语义。
 *
 * 模块依赖约束（002 2.2）：agents 属于 Config 扩展点，只依赖 node 内建
 * （fs / path）与本模块 parse，不 import 任何 core 其他符号。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一个已发现 agent：解析结果 + 来源文件 / 层级。 */
export interface DiscoveredAgent extends CustomAgent {
  /** 发现层级（同名覆盖的裁决依据：project > global）。 */
  readonly level: 'global' | 'project';
}

/** discoverAgents 入参。 */
export interface DiscoverAgentsOptions {
  /** 引导主目录：全局层位于 `<homeDir>/.modou/agents/`。 */
  readonly homeDir: string;
  /** 项目根：项目层位于 `<projectRoot>/.modou/agents/`。 */
  readonly projectRoot: string;
}

/** discoverAgents 产出：加载的 agents + 被跳过的文件（诊断用，不静默）。 */
export interface DiscoverAgentsResult {
  /** 全部已发现 agent（按名排序，确定性；项目覆盖全局同名）。 */
  readonly agents: readonly DiscoveredAgent[];
  /** 因缺 name/description/正文而被跳过的文件（相对所在层级目录的路径）。 */
  readonly skipped: readonly string[];
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 路径是否为目录（发现时跳过不存在的层级目录）。 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 扫描单个 agent 层级目录（`<dir>` 下的各 `*.md`）：
 * - 隐藏文件（`.` 开头）跳过；
 * - 排序稳定（文件名 localeCompare），供同名覆盖时按层级内的确定性顺序处理。
 * - 解析失败（缺 name/description/正文）的文件进入 skipped（文件名相对目录）。
 */
function loadAgentsFromDir(
  dir: string,
  level: 'global' | 'project',
): { agents: DiscoveredAgent[]; skipped: string[] } {
  const agents: DiscoveredAgent[] = [];
  const skipped: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return { agents, skipped };
  }
  for (const name of names) {
    const file = join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      skipped.push(name);
      continue;
    }
    const agent = parseAgentMarkdown(text, file);
    if (agent === null) {
      skipped.push(name);
      continue;
    }
    agents.push({ ...agent, level });
  }
  return { agents, skipped };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 两级发现并加载全部自定义 agent（同步、纯函数、可离线测试）。
 *
 * 优先级（同名覆盖）：global < project——项目层覆盖全局层同名 agent。
 * 返回值按 agent 名排序（确定性，进系统提示词角色清单的顺序稳定）。
 *
 * @returns 全部已发现 agent（无 agent 时为空数组，不抛错）+ 被跳过的文件。
 */
export function discoverAgents(
  options: DiscoverAgentsOptions,
): DiscoverAgentsResult {
  const layers: ReadonlyArray<{
    readonly level: 'global' | 'project';
    readonly dir: string;
  }> = [
    { level: 'global', dir: join(options.homeDir, '.modou', 'agents') },
    { level: 'project', dir: join(options.projectRoot, '.modou', 'agents') },
  ];

  const byName = new Map<string, DiscoveredAgent>();
  const skipped: string[] = [];
  for (const { level, dir } of layers) {
    if (!isDirectory(dir)) continue;
    const loaded = loadAgentsFromDir(dir, level);
    skipped.push(...loaded.skipped);
    for (const agent of loaded.agents) {
      // 后面的层级覆盖前面的同名 agent（project > global）
      byName.set(agent.name, agent);
    }
  }
  return {
    agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    skipped,
  };
}
