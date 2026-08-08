/**
 * /init（T-132，0.13.0）：分析仓库结构 → 生成 AGENTS.md 初稿。
 *
 * `probeRepository` 用 fs 直接探测（读 package.json / 锁文件 / 配置文件 /
 * 目录布局），产出 `RepositoryProfile`（技术栈 / 测试命令 / 规范 / CI）；
 * `generateAgentsMd` 用**固定模板 + 探测结果**渲染初稿；`runInit` 组合两者，
 * 把初稿写到 `<cwd>/AGENTS.md`（已存在时不覆盖，返回 existed）。
 *
 * 为什么用 fs 而非工具管线：探测是只读、同步、一次性的，直接 readFileSync /
 * existsSync 最确定性、可离线测试；工具管线（read/grep/glob）要过权限与审批，
 * 不适合作为「生成 AGENTS.md」的自身实现。本模块不依赖任何其他 core 模块
 * （除类型），保持零依赖。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// 探测结果
// ---------------------------------------------------------------------------

/** 包管理器（按锁文件判定）。 */
export type PackageManager = 'bun' | 'npm' | 'yarn' | 'pnpm' | 'unknown';

/** 仓库结构探测结果（/init 的数据源）。 */
export interface RepositoryProfile {
  /** 被探测的目录（realpath 归一）。 */
  readonly cwd: string;
  /** 识别出的语言（typescript / javascript / python / go / rust / ...）。 */
  readonly languages: readonly string[];
  /** 识别出的框架（react / vue / next / express / ...）。 */
  readonly frameworks: readonly string[];
  readonly packageManager: PackageManager;
  /** package.json scripts 里取出的命令（未配置则 undefined）。 */
  readonly scripts: {
    readonly test?: string;
    readonly lint?: string;
    readonly build?: string;
    readonly typecheck?: string;
  };
  /** 派生出的测试命令（scripts.test 缺失时按锁文件推断；仍无则 undefined）。 */
  readonly testCommandHint?: string;
  readonly hasTypescript: boolean;
  /** 识别出的格式化工具（prettier / biome）。 */
  readonly formatters: readonly string[];
  /** 识别出的 linter（eslint / biome）。 */
  readonly linters: readonly string[];
  /** 识别出的 CI（github-actions / gitlab-ci / ...）。 */
  readonly ci: readonly string[];
  /** 测试文件 glob 模式（默认按语言推断）。 */
  readonly testPatterns: readonly string[];
  readonly hasAgentsMd: boolean;
  readonly hasReadme: boolean;
  /** 探测过程中的补充说明（未识别出测试命令等）。 */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// 探测实现
// ---------------------------------------------------------------------------

/** 读取文件内容；不存在 / 读取失败返回 undefined（探测尽力而为）。 */
function tryRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** 目录是否存在（且确实是目录）。 */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 文件是否存在（且确实是文件）。 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 宽松解析 package.json（损坏时返回 undefined；探测不因坏 JSON 崩溃）。 */
function parsePackageJson(
  text: string | undefined,
): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 目录下是否有匹配后缀的文件（测试目录 / 入口探测用）。 */
function hasFileWithExtension(
  dir: string,
  extensions: readonly string[],
): boolean {
  try {
    return readdirSync(dir).some(
      (name) =>
        statSync(join(dir, name)).isFile() &&
        extensions.some((ext) => name.endsWith(ext)),
    );
  } catch {
    return false;
  }
}

/**
 * 探测仓库结构（只读）。探测不到的字段给保守默认 + note（不静默），
 * 让生成出的 AGENTS.md 对该项明确说「未识别」，而非假装知道。
 */
export function probeRepository(cwd: string): RepositoryProfile {
  const realCwd = (() => {
    try {
      return statSync(cwd).isDirectory() ? cwd : cwd;
    } catch {
      return cwd;
    }
  })();
  const notes: string[] = [];
  const languages: string[] = [];
  const frameworks: string[] = [];
  const formatters: string[] = [];
  const linters: string[] = [];
  const ci: string[] = [];

  // —— 包管理器 + scripts（package.json / 锁文件）——
  const pkg = parsePackageJson(tryRead(join(realCwd, 'package.json')));
  const scripts = pkg?.scripts as Record<string, unknown> | undefined;
  const scriptOf = (name: string): string | undefined => {
    const value = scripts?.[name];
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : undefined;
  };
  let packageManager: PackageManager = 'unknown';
  if (isFile(join(realCwd, 'bun.lockb')) || isFile(join(realCwd, 'bun.lock'))) {
    packageManager = 'bun';
  } else if (isFile(join(realCwd, 'pnpm-lock.yaml'))) {
    packageManager = 'pnpm';
  } else if (isFile(join(realCwd, 'yarn.lock'))) {
    packageManager = 'yarn';
  } else if (isFile(join(realCwd, 'package-lock.json'))) {
    packageManager = 'npm';
  }

  if (pkg !== undefined) {
    const rawDeps = [
      ...(Array.isArray(pkg.dependencies)
        ? []
        : Object.keys((pkg.dependencies as Record<string, unknown>) ?? {})),
      ...(Array.isArray(pkg.devDependencies)
        ? []
        : Object.keys((pkg.devDependencies as Record<string, unknown>) ?? {})),
    ];
    if (rawDeps.includes('typescript')) languages.push('typescript');
    if (rawDeps.includes('react')) frameworks.push('react');
    if (rawDeps.includes('vue')) frameworks.push('vue');
    if (rawDeps.includes('next')) frameworks.push('next');
    if (rawDeps.includes('express')) frameworks.push('express');
    if (rawDeps.includes('vitest') || rawDeps.includes('jest')) {
      // 测试框架（scripts.test 优先，见下）
    }
  }

  // —— 语言按配置文件补充 ——
  if (isFile(join(realCwd, 'tsconfig.json'))) {
    languages.push('typescript');
  }
  if (hasFileWithExtension(realCwd, ['.ts', '.tsx', '.mts', '.cts'])) {
    if (!languages.includes('typescript')) languages.push('typescript');
  }
  if (hasFileWithExtension(realCwd, ['.js', '.jsx', '.mjs', '.cjs'])) {
    if (!languages.includes('javascript')) languages.push('javascript');
  }
  if (
    isFile(join(realCwd, 'pyproject.toml')) ||
    isFile(join(realCwd, 'requirements.txt')) ||
    isFile(join(realCwd, 'setup.py'))
  ) {
    languages.push('python');
  }
  if (isFile(join(realCwd, 'go.mod'))) languages.push('go');
  if (isFile(join(realCwd, 'Cargo.toml'))) languages.push('rust');

  // —— 规范工具 ——
  if (
    isFile(join(realCwd, '.prettierrc')) ||
    isFile(join(realCwd, '.prettierrc.json')) ||
    isFile(join(realCwd, '.prettierrc.json5')) ||
    isFile(join(realCwd, '.prettierrc.yaml')) ||
    isFile(join(realCwd, '.prettierrc.yml')) ||
    isFile(join(realCwd, '.prettierrc.toml')) ||
    isFile(join(realCwd, '.prettierrc.js')) ||
    isFile(join(realCwd, '.prettierrc.mjs')) ||
    isFile(join(realCwd, 'prettier.config.js')) ||
    isFile(join(realCwd, 'prettier.config.mjs'))
  ) {
    formatters.push('prettier');
  }
  if (
    isFile(join(realCwd, 'biome.json')) ||
    isFile(join(realCwd, 'biome.jsonc'))
  ) {
    formatters.push('biome');
    linters.push('biome');
  }
  if (
    isFile(join(realCwd, 'eslint.config.js')) ||
    isFile(join(realCwd, 'eslint.config.mjs')) ||
    isFile(join(realCwd, '.eslintrc')) ||
    isFile(join(realCwd, '.eslintrc.json')) ||
    isFile(join(realCwd, '.eslintrc.cjs'))
  ) {
    linters.push('eslint');
  }

  // —— CI ——
  if (isDir(join(realCwd, '.github', 'workflows'))) ci.push('github-actions');
  if (isFile(join(realCwd, '.gitlab-ci.yml'))) ci.push('gitlab-ci');
  if (isFile(join(realCwd, '.circleci', 'config.yml'))) ci.push('circleci');

  // —— 测试命令与测试模式 ——
  const testPatterns = inferTestPatterns(realCwd, languages);
  const testScript = scriptOf('test');
  const testCommand =
    testScript ??
    (packageManager === 'bun'
      ? 'bun test'
      : packageManager === 'pnpm'
        ? 'pnpm test'
        : packageManager === 'yarn'
          ? 'yarn test'
          : packageManager === 'npm'
            ? 'npm test'
            : undefined);
  if (testScript === undefined && testCommand !== undefined) {
    notes.push('package.json 未配置 test script，按锁文件推断默认测试命令');
  }
  if (testCommand === undefined && testPatterns.length === 0) {
    notes.push('未识别出测试命令与测试文件——生成稿对此明确标注「未识别」');
  }

  return {
    cwd: realCwd,
    languages: dedupe(languages),
    frameworks: dedupe(frameworks),
    packageManager,
    scripts: {
      test: scriptOf('test'),
      lint: scriptOf('lint'),
      build: scriptOf('build'),
      typecheck: scriptOf('typecheck'),
    },
    ...(testCommand !== undefined ? { testCommandHint: testCommand } : {}),
    hasTypescript: languages.includes('typescript'),
    formatters: dedupe(formatters),
    linters: dedupe(linters),
    ci: dedupe(ci),
    testPatterns,
    hasAgentsMd:
      isFile(join(realCwd, 'AGENTS.md')) || isFile(join(realCwd, 'CLAUDE.md')),
    hasReadme:
      isFile(join(realCwd, 'README.md')) ||
      isFile(join(realCwd, 'README-CN.md')),
    notes: dedupe(notes),
  };
}

/** 去重保序。 */
function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** 按语言 / 目录布局推断测试文件 glob 模式。 */
function inferTestPatterns(
  cwd: string,
  languages: readonly string[],
): string[] {
  const patterns: string[] = [];
  const hasTypescript = languages.includes('typescript');
  const ext = hasTypescript ? '{ts,tsx,js,jsx}' : '{js,jsx}';
  // 测试目录（__tests__ / test / tests）在任意深度都可命中
  if (findDirNamed(cwd, ['__tests__', 'test', 'tests'], 3)) {
    patterns.push(
      `**/__tests__/**/*.${ext}`,
      `**/test/**/*.${ext}`,
      `**/tests/**/*.${ext}`,
    );
  }
  // 根 / 任意子目录存在 *.test.ts / *.spec.ts 之类测试文件时，追加通用模式
  const testMarker = hasTypescript
    ? [
        '.test.ts',
        '.test.tsx',
        '.spec.ts',
        '.spec.tsx',
        '.test.js',
        '.test.jsx',
      ]
    : ['.test.js', '.test.jsx', '.spec.js', '.spec.jsx'];
  if (findFileWithMarker(cwd, testMarker, 3)) {
    patterns.push(`**/*.test.${ext}`, `**/*.spec.${ext}`);
  }
  return dedupe(patterns);
}

/** 递归（限深度）查找名为 names 之一的目录。 */
function findDirNamed(
  dir: string,
  names: readonly string[],
  maxDepth: number,
): boolean {
  if (maxDepth < 0) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) {
      continue;
    }
    const full = join(dir, name);
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory() && names.includes(name)) {
      return true;
    }
    if (stat.isDirectory() && findDirNamed(full, names, maxDepth - 1)) {
      return true;
    }
  }
  return false;
}

/** 递归（限深度）查找带标记后缀的文件（测试文件探测用）。 */
function findFileWithMarker(
  dir: string,
  markers: readonly string[],
  maxDepth: number,
): boolean {
  if (maxDepth < 0) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) {
      continue;
    }
    const full = join(dir, name);
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isFile() && markers.some((marker) => name.endsWith(marker))) {
      return true;
    }
    if (stat.isDirectory() && findFileWithMarker(full, markers, maxDepth - 1)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// AGENTS.md 初稿（固定模板 + 探测结果）
// ---------------------------------------------------------------------------

/** 生成 AGENTS.md 初稿。模板固定，占位符由探测结果填充。 */
export function generateAgentsMd(profile: RepositoryProfile): string {
  const languageLine =
    profile.languages.length > 0
      ? profile.languages.join(' / ')
      : '未识别（请补充）';
  const frameworkLine =
    profile.frameworks.length > 0
      ? profile.frameworks.join(' / ')
      : '无（或未识别）';
  const managerLine =
    profile.packageManager === 'unknown' ? '未识别' : profile.packageManager;
  const installCommand =
    profile.packageManager === 'unknown'
      ? '<包管理器>'
      : `${profile.packageManager} install`;

  const commandLines: string[] = [];
  commandLines.push(`- 安装依赖：\`${installCommand}\``);
  if (profile.scripts.test !== undefined) {
    commandLines.push(`- 测试：\`${profile.scripts.test}\``);
  } else if (profile.testCommandHint !== undefined) {
    commandLines.push(`- 测试：\`${profile.testCommandHint}\``);
  } else {
    commandLines.push('- 测试：未识别（请补充；测试文件：见「测试」节）');
  }
  if (profile.scripts.lint !== undefined) {
    commandLines.push(`- Lint：\`${profile.scripts.lint}\``);
  } else if (profile.linters.length > 0) {
    commandLines.push(
      `- Lint：\`${profile.linters[0]}\`（检测到 ${profile.linters.join(' / ')}，命令以项目实际为准）`,
    );
  } else {
    commandLines.push('- Lint：未识别（请补充）');
  }
  if (profile.scripts.typecheck !== undefined) {
    commandLines.push(`- 类型检查：\`${profile.scripts.typecheck}\``);
  } else if (profile.hasTypescript) {
    commandLines.push(
      '- 类型检查：`tsc --noEmit`（检测到 TypeScript，命令以项目实际为准）',
    );
  }
  if (profile.scripts.build !== undefined) {
    commandLines.push(`- 构建：\`${profile.scripts.build}\``);
  }

  const conventionLines: string[] = [];
  if (profile.formatters.length > 0) {
    conventionLines.push(
      `- 格式化：检测到 ${profile.formatters.join(' / ')}——改动后按项目格式化配置排版（若项目配了 format 脚本，跑它）。`,
    );
  }
  if (profile.linters.length > 0) {
    conventionLines.push(
      `- 静态检查：检测到 ${profile.linters.join(' / ')}——改动后跑 lint，保持全绿。`,
    );
  }
  if (conventionLines.length === 0) {
    conventionLines.push(
      '- 代码规范：未检测到格式化 / 静态检查配置（请按项目实际补充）。',
    );
  }

  const testPatternLine =
    profile.testPatterns.length > 0
      ? profile.testPatterns.join('、')
      : '未识别（请按项目实际补充测试文件位置）';

  const ciLine =
    profile.ci.length > 0
      ? `检测到 CI：${profile.ci.join(' / ')}——改动应保证 CI 可过（含测试 / lint / 构建）。`
      : '未检测到 CI 配置。';

  const tsLine = profile.hasTypescript
    ? '项目使用 TypeScript：新代码保持类型安全，避免 any 逃逸（以项目既有类型风格为准）。'
    : '';

  const date = new Date().toISOString().slice(0, 10);

  const sections = [
    '# AGENTS.md',
    '',
    `> 由 modou /init 自动生成（${date}）。以下内容基于仓库结构自动探测，` +
      '请核对并补充后开始使用——探测结果是尽力而为的初稿，不是权威事实。',
    '',
    '## 项目概览',
    '',
    `- 语言：${languageLine}`,
    `- 框架：${frameworkLine}`,
    `- 包管理器：${managerLine}`,
    '',
    '## 常用命令',
    '',
    ...commandLines,
    '',
    '## 测试',
    '',
    `- 测试文件模式：\`${testPatternLine}\``,
    '- 修改涉及已有测试时，先跑相关测试再动手，改完再跑一遍确认全绿。',
    '',
    '## 代码规范',
    '',
    ...conventionLines,
    '',
    '## CI',
    '',
    ciLine,
    '',
    '## 给 AI 助手的工作约定',
    '',
    '- 动手改代码前，先读相关文件与既有测试，理解现状再改。',
    '- 小步推进：每次改动应能独立运行 / 独立验证，再继续下一步。',
    '- 修改后运行测试与 lint（命令见上），保持全绿再收尾。',
    '- 不擅自扩大改动范围：只做任务要求的事，不做「顺手」的重构。',
    '- 改动设计 / 结构前先读项目文档（README / 设计文档）与既有约定。',
    ...(tsLine.length > 0 ? [tsLine] : []),
    '',
    '---',
    '',
    '_本文件由 modou /init 生成。可手动编辑；改动会持久保留。_',
    '',
  ];
  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// runInit：组合探测 + 生成 + 落盘
// ---------------------------------------------------------------------------

/** runInit 的产出。 */
export interface InitResult {
  readonly profile: RepositoryProfile;
  /** 生成的初稿全文。 */
  readonly draft: string;
  /** 目标路径（`<cwd>/AGENTS.md`）。 */
  readonly targetPath: string;
  /** 是否已写入（AGENTS.md / CLAUDE.md 已存在时不覆盖，为 false）。 */
  readonly wrote: boolean;
}

/**
 * 执行一次 /init：探测仓库 → 生成 AGENTS.md 初稿 → 写入 `<cwd>/AGENTS.md`。
 *
 * 已存在 AGENTS.md / CLAUDE.md 时**不覆盖**（wrote: false，调用方提示用户
 * 手动合并），绝不静默覆盖用户已有指令文件。写入失败抛出（调用方以 notice
 * 上报）。
 */
export function runInit(cwd: string): InitResult {
  const profile = probeRepository(cwd);
  const draft = generateAgentsMd(profile);
  const targetPath = join(cwd, 'AGENTS.md');
  // 覆盖判断与 docstring 一致：探测结果 hasAgentsMd 同时判 AGENTS.md 与
  // CLAUDE.md（CLAUDE.md 是兼容指令文件，已存在同样不应覆盖）——不再只查
  // AGENTS.md 单文件（0.13.0 必修：docstring 说两个文件、实现只查一个）。
  const wrote = !profile.hasAgentsMd;
  if (wrote) {
    // runInit 是同步纯逻辑；文件写入用 node:fs 同步（TUI 斜杠命令调用，
    // 一次性的小文件写入，无需异步管线）。
    writeFileSync(targetPath, draft, 'utf8');
  }
  return { profile, draft, targetPath, wrote };
}
