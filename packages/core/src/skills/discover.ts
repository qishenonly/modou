import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listSkillFiles,
  parseSkillMarkdown,
  readSkillMarkdown,
  type ParsedSkill,
} from './parse';

/**
 * 技能发现与加载（design 002 §10 扩展点表「Skills = Config 发现」，0.15.0 T-151）。
 *
 * 三级发现（002 十二节用户侧布局 `~/.modou/skills/` 与 `<project>/.modou/skills/`）：
 * - 仓库内置 `skills/`（本模块所在包的上四级目录，即仓库根的 skills/）——最低优先级；
 * - 全局 `~/.modou/skills/`（homeDir 注入，测试用临时目录隔离）；
 * - 项目级 `<projectRoot>/.modou/skills/`——最高优先级。
 *
 * 同名覆盖规则：**项目覆盖全局、全局覆盖内置**（后者覆盖前者）——用户想调整
 * 某个技能的行为，不必删掉内置/全局版，在自己的层级放同名技能即可。
 *
 * 发现即加载：对每个含 SKILL.md 的目录，同步解析出 name / description /
 * allowed-tools / 正文与附带文件清单（T-152 渐进式披露的加载侧：正文此刻已在
 * 内存里，但**只有** name + description 进上下文清单，正文等 Skill 工具命中才注入）。
 *
 * 模块依赖约束（002 2.2）：skills 属于 Config 扩展点，只依赖 node 内建
 * （fs / path）与本模块 parse，不 import 任何 core 其他符号。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 技能的发现层级（优先级自低到高：builtin → global → project → extra）。 */
export type SkillLevel = 'builtin' | 'global' | 'project' | 'extra';

/** 一个已发现技能：解析结果 + 来源目录 / 层级 + 附带文件清单。 */
export interface DiscoveredSkill extends ParsedSkill {
  /** 技能目录（含 SKILL.md 的绝对路径；Skill 工具注入正文时给出出处）。 */
  readonly directory: string;
  /** 发现层级（同名覆盖的裁决依据：extra > project > global > builtin）。 */
  readonly level: SkillLevel;
  /** 附带文件清单（相对技能目录；不含 SKILL.md 本身）。 */
  readonly files: readonly string[];
}

/** discoverSkills 入参。 */
export interface DiscoverSkillsOptions {
  /** 引导主目录：全局层位于 `<homeDir>/.modou/skills/`。 */
  readonly homeDir: string;
  /** 项目根：项目层位于 `<projectRoot>/.modou/skills/`。 */
  readonly projectRoot: string;
  /**
   * 内置技能目录（仓库内 skills/）。缺省 = 本模块所在包的上四级目录
   * （packages/core/src/skills → 仓库根）下的 skills/。测试用临时目录注入隔离。
   */
  readonly builtinDir?: string;
  /**
   * 额外扫描目录（GUI 配置的自定义技能根，如团队共享的技能仓库）。
   * 追加在 project 层之后（同名覆盖 project/global/builtin）；可选，缺省不扫。
   */
  readonly extraDirs?: readonly string[];
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 路径是否存在（发现时跳过不存在的层级目录）。 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 判断一个目录是否真的承载内置技能：存在至少一个「含 SKILL.md 的子目录」。
 *
 * 为什么要「真的承载」：上退查找沿途可能路过既有的 `skills/` 目录（例如
 * 本模块自身所在的 `src/skills/` 是源码目录，不是技能仓库），只有含
 * SKILL.md 子目录的 `skills/` 才是发布形态的技能目录。
 */
function containsSkill(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        statSync(join(dir, entry.name, 'SKILL.md'));
        return true;
      } catch {
        // 该子目录无 SKILL.md（不是技能目录），继续看下一个
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * 从任意起始目录向上查找内置技能目录：第一个「子级含 skills/ 且该 skills/
 * 承载技能」的祖先。
 *
 * 需要向上多退的原因——两种发布布局下本模块的深度不同：
 * - 源码/工作区布局：`packages/core/src/skills/` → 上四级即仓库根，其 skills/
 *   即内置技能；
 * - npm 嵌套安装布局：根包 modou 以 bundleDependencies 内嵌 @modou/core，
 *   实际路径是 `node_modules/modou/node_modules/@modou/core/src/skills/` →
 *   需要上退 **六级** 才到 `node_modules/modou/`，其 skills/ 才是随包发布的
 *   内置技能。固定退四级的旧实现会退到 `node_modules/` 下的 `skills/`（不存在），
 *   内置技能安装后不可发现——本函数用「上退 + 存在性探测」同时覆盖两种布局。
 *
 * 上退有界（12 层）：防止在异常的文件系统布局下一直退到根目录；找不到时回落
 * 源码布局的四级上退路径（可能不存在，discoverSkills 对不存在的目录静默跳过）。
 *
 * @param startDir 起始目录（缺省场景 = 本模块所在目录，即 import.meta.dir）。
 */
export function findBuiltinSkillsDir(startDir: string): string {
  let dir = startDir;
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, 'skills');
    if (isDirectory(candidate) && containsSkill(candidate)) return candidate;
    const parent = join(dir, '..');
    if (parent === dir) break; // 已到文件系统根
    dir = parent;
  }
  // 兜底：源码布局的四级上退（dev 工作树）。路径不存在时 discoverSkills 跳过。
  return join(startDir, '..', '..', '..', '..', 'skills');
}

/**
 * 内置技能目录的缺省位置：从本模块所在目录向上查找第一个承载技能的 skills/。
 *
 * 说明：modou 以源码形态发布（根包 files 白名单含 skills/），安装后的内置技能
 * 位于 `node_modules/modou/skills/`——与 `import.meta.dir`（内嵌 core 的
 * `node_modules/modou/node_modules/@modou/core/src/skills/`）相距六级，固定上退
 * 四级会失配，故用 findBuiltinSkillsDir 探测。编译单文件形态（bun build）需要
 * 把 skills/ 随产物分发——这是打包面的事，发现逻辑不感知。
 */
export function defaultBuiltinSkillsDir(): string {
  // 用 import.meta.url 而非 Bun 专属的 import.meta.dir：core 需在 Node/Electron
  // （GUI 主进程 bundle 进 core）与 Bun 双运行时下可加载。
  return findBuiltinSkillsDir(fileURLToPath(new URL('.', import.meta.url)));
}

/**
 * 扫描单个技能层级目录（<dir> 目录下各子技能目录的 SKILL.md）：
 * - 每个含 SKILL.md 的子目录 = 一个技能，目录名作为 frontmatter 缺 name 的回落；
 * - 隐藏目录（`.` 开头）跳过；
 * - 排序稳定（目录名 localeCompare），供重复名覆盖时按层级内的确定性顺序处理。
 */
function loadSkillsFromDir(dir: string, level: SkillLevel): DiscoveredSkill[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  const result: DiscoveredSkill[] = [];
  for (const entryName of names) {
    const skillDir = join(dir, entryName);
    const markdown = readSkillMarkdown(skillDir);
    if (markdown === null) continue; // 无 SKILL.md 的目录不是技能，跳过
    const parsed = parseSkillMarkdown(markdown, entryName);
    result.push({
      ...parsed,
      directory: skillDir,
      level,
      files: listSkillFiles(skillDir),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 三级发现并加载全部技能（同步、纯函数、可离线测试）。
 *
 * 优先级（同名覆盖）：builtin < global < project——后发现的层级覆盖先发现的
 * 同名技能。返回值按技能名排序（确定性，进清单的顺序稳定）。
 *
 * @returns 全部已发现技能（无技能时为空数组，不抛错）。
 */
export function discoverSkills(
  options: DiscoverSkillsOptions,
): DiscoveredSkill[] {
  const layers: ReadonlyArray<{
    readonly level: SkillLevel;
    readonly dir: string;
  }> = [
    { level: 'builtin', dir: options.builtinDir ?? defaultBuiltinSkillsDir() },
    { level: 'global', dir: join(options.homeDir, '.modou', 'skills') },
    {
      level: 'project',
      dir: join(options.projectRoot, '.modou', 'skills'),
    },
    // extra：GUI 配置的额外技能根（追加在项目层之后，同名覆盖所有默认层级）
    ...(options.extraDirs ?? []).map((dir) => ({
      level: 'extra' as const,
      dir,
    })),
  ];

  const byName = new Map<string, DiscoveredSkill>();
  for (const { level, dir } of layers) {
    if (!isDirectory(dir)) continue;
    for (const skill of loadSkillsFromDir(dir, level)) {
      // 后面的层级覆盖前面的同名技能（project > global > builtin）
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
