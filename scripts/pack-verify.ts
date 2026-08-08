#!/usr/bin/env bun
/**
 * 打包验证脚本（T-092 打包分发，`bun run pack:verify`）。
 *
 * 职责（发布门的一部分）：
 *   1. 刷新 file: 内嵌的 @modou/core（bun install 同步 packages/core → node_modules，
 *      保证打包用的是最新源码，不被 node_modules 里的旧副本坑到）；
 *   2. `npm pack` 产出 tarball（先清掉 tsc 的 dist/tsbuildinfo，避免编译产物进包）；
 *   3. 包内容断言：bin 存在、tui/core 源码在、无 dist 残留、单元测试不泄漏
 *      （保留 eval/fixtures 数据与 provider/contract 运行时导出）；
 *   4. 安装冒烟：tarball 装进临时目录，跑 `modou --version` 与 `--help`
 *      （无 TTY 环境下的启动验证；TUI 本体需要 TTY，不在此覆盖）；
 *   5. 内置技能发现冒烟（0.15.0 打包修复）：安装后的嵌套布局
 *      （node_modules/modou/node_modules/@modou/core）下直接 import
 *      discoverSkills，缺省内置目录应经向上多退找到随包发布的
 *      node_modules/modou/skills/，4 个内置技能全部可发现。
 *
 * 用法：`bun run pack:verify`（仓库根目录）。退出码非 0 = 验证失败。
 * 需要网络（安装冒烟要从 registry 拉 ink/react 等运行时依赖）。
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 断言失败消息（以中文描述具体哪个断言挂了，便于定位）。 */
class AssertionError extends Error {}

/** 运行命令并返回 stdout（非零退出码抛错，stderr 并入错误信息）。 */
function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new AssertionError(
      `命令失败: ${command} ${args.join(' ')}\n退出码 ${String(result.status)}\n${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

/** 断言条件成立，否则抛错（携带上下文）。 */
function check(condition: boolean, message: string): void {
  if (!condition) throw new AssertionError(message);
}

/** 列出 tarball 内的全部条目（tar tzf 输出按行）。 */
function listTarballEntries(tarball: string): string[] {
  const out = run('tar', ['tzf', tarball]);
  return out.split('\n').filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// 主体
// ---------------------------------------------------------------------------

function main(): void {
  const rootPackage = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8'),
  ) as {
    name: string;
    version: string;
    bin?: Record<string, string>;
    files?: string[];
    engines?: Record<string, string>;
    dependencies?: Record<string, string>;
    bundleDependencies?: string[];
  };
  check(rootPackage.name === 'modou', '根包名必须是 modou');
  void mainAsync(rootPackage).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function mainAsync(rootPackage: {
  name: string;
  version: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  bundleDependencies?: string[];
}): Promise<void> {
  // 临时注入 file: 依赖：开发期根 package.json 不声明 @modou/core（保持 workspace
  // 软链、改动即时生效）；打包时才需要它内嵌 core 进 tarball（bundleDependencies）。
  // 打包验证结束后还原 package.json，避免污染开发环境。
  const originalRootPkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
  {
    const pkg = JSON.parse(originalRootPkg) as {
      dependencies?: Record<string, string>;
    };
    pkg.dependencies = pkg.dependencies ?? {};
    pkg.dependencies['@modou/core'] = 'file:packages/core';
    writeFileSync(
      join(ROOT, 'package.json'),
      `${JSON.stringify(pkg, null, 2)}\n`,
    );
  }

  // ① 刷新 file: 内嵌依赖 + 清编译产物（dist 是 tsc 的产物，进包即残留）
  run('bun', ['install']);
  rmSync(join(ROOT, 'packages/core/dist'), { recursive: true, force: true });
  rmSync(join(ROOT, 'packages/tui/dist'), { recursive: true, force: true });
  rmSync(join(ROOT, 'packages/core/tsconfig.tsbuildinfo'), { force: true });
  rmSync(join(ROOT, 'packages/tui/tsconfig.tsbuildinfo'), { force: true });

  // ② 打包
  const tarballName = `${rootPackage.name}-${rootPackage.version}.tgz`;
  const tarball = join(ROOT, tarballName);
  rmSync(tarball, { force: true });
  run('npm', ['pack']);
  check(existsSync(tarball), `tarball 未生成: ${tarball}`);
  const entries = listTarballEntries(tarball);

  // ③ 包内容断言
  const binTarget = Object.values(rootPackage.bin ?? {}).map((path) =>
    path.replace(/^\.\//, ''),
  );
  for (const target of binTarget) {
    check(entries.includes(`package/${target}`), `bin 目标不在包里: ${target}`);
  }
  // tui 源码直接发布；core 源码随内嵌依赖 @modou/core 进包（node_modules 下）
  check(
    entries.includes('package/packages/tui/src/index.ts'),
    'tui 源码不在包里（packages/tui/src/index.ts）',
  );
  check(
    entries.includes('package/node_modules/@modou/core/src/index.ts'),
    'core 源码不在包里（内嵌 @modou/core/src/index.ts）',
  );
  check(
    entries.includes(
      'package/node_modules/@modou/core/src/provider/contract/contract.test.ts',
    ),
    '内嵌 @modou/core 缺少运行时导出的 contract.test.ts',
  );

  // 无 dist 残留：modou 自带源码与内嵌 core 都不得带编译产物
  const distResidue = entries.filter((entry) =>
    /^package\/(packages\/.+|node_modules\/@modou\/core)\/.*\/dist\//.test(
      entry,
    ),
  );
  check(
    distResidue.length === 0,
    `包内发现 dist 残留:\n${distResidue.join('\n')}`,
  );

  // 单元测试不泄漏：tui 自带源码零测试；内嵌 core 只允许 eval/fixtures 数据
  // 与 contract.test.ts（provider/index.ts 运行时导出它）
  const leakedTests = entries.filter((entry) => {
    if (/^package\/packages\/.*\.test\.(ts|tsx)$/.test(entry)) return true;
    if (
      !/^package\/node_modules\/@modou\/core\/.*\.test\.(ts|tsx)$/.test(entry)
    ) {
      return false;
    }
    return (
      !/eval\/fixtures\//.test(entry) && !/provider\/contract\//.test(entry)
    );
  });
  check(
    leakedTests.length === 0,
    `包内泄漏单元测试:\n${leakedTests.join('\n')}`,
  );

  // tarball 内的 package.json：发布相关字段齐备
  const packedPackage = JSON.parse(
    run('tar', ['xzf', tarball, '-O', 'package/package.json']),
  ) as {
    bin?: Record<string, string>;
    files?: string[];
    engines?: Record<string, string>;
    dependencies?: Record<string, string>;
    bundleDependencies?: string[];
  };
  check(
    packedPackage.bin?.modou !== undefined &&
      packedPackage.bin?.mo !== undefined,
    'tarball package.json 缺少 bin（modou / mo）',
  );
  check(
    packedPackage.dependencies?.['@modou/core'] !== undefined,
    'tarball package.json 缺少依赖 @modou/core',
  );
  check(
    packedPackage.bundleDependencies?.includes('@modou/core') === true,
    'tarball package.json 的 bundleDependencies 未包含 @modou/core',
  );
  check(
    packedPackage.engines?.bun !== undefined,
    'tarball package.json 缺少 engines.bun（运行时依赖 bun）',
  );
  check(
    Array.isArray(packedPackage.files) && packedPackage.files.length > 0,
    'tarball package.json 缺少 files 白名单',
  );

  // ④ 安装冒烟：tarball → 临时项目 → modou --version / --help
  const smokeDir = mkdtempSync(join(tmpdir(), 'modou-pack-verify-'));
  try {
    writeFileSync(
      join(smokeDir, 'package.json'),
      JSON.stringify({ name: 'smoke', version: '0.0.0', private: true }),
    );
    run('npm', ['install', '--no-audit', '--no-fund', tarball], {
      cwd: smokeDir,
    });
    const binPath = join(
      smokeDir,
      'node_modules',
      '.bin',
      Object.keys(rootPackage.bin ?? {})[0] ?? 'modou',
    );
    check(existsSync(binPath), `安装后 bin 链接不存在: ${binPath}`);

    const versionOut = run('bun', [binPath, '--version'], { cwd: smokeDir });
    check(
      versionOut.trim() === `modou ${rootPackage.version}`,
      `--version 输出不符: ${JSON.stringify(versionOut)}`,
    );

    const helpOut = run('bun', [binPath, '--help'], { cwd: smokeDir });
    check(
      helpOut.includes(`modou ${rootPackage.version}`) &&
        helpOut.includes('/help'),
      '--help 输出不完整',
    );

    // ⑤ 内置技能发现冒烟（0.15.0 打包修复）：安装后的嵌套布局下，直接从
    // 内嵌 core 的 discover.ts 出发调用 discoverSkills——defaultBuiltinSkillsDir
    // 必须经向上多退找到随包发布的 node_modules/modou/skills/（而非固定四级上退
    // 落到 node_modules/skills 这种不存在的路径），4 个内置技能全部可发现。
    const discoverPath = join(
      smokeDir,
      'node_modules',
      'modou',
      'node_modules',
      '@modou',
      'core',
      'src',
      'skills',
      'discover.ts',
    );
    check(
      existsSync(discoverPath),
      `安装后内嵌 core 的 discover.ts 不在期望路径: ${discoverPath}`,
    );
    const { discoverSkills } = (await import(discoverPath)) as {
      discoverSkills: (options: {
        homeDir: string;
        projectRoot: string;
      }) => ReadonlyArray<{
        readonly name: string;
        readonly level: string;
        readonly description: string;
        readonly body: string;
      }>;
    };
    const discovered = discoverSkills({
      homeDir: join(smokeDir, 'home'),
      projectRoot: smokeDir,
    });
    const builtinNames = discovered
      .filter((skill) => skill.level === 'builtin')
      .map((skill) => skill.name)
      .sort();
    const expectedBuiltin = [
      'code-review',
      'commit-message',
      'debugging',
      'write-tests',
    ];
    for (const name of expectedBuiltin) {
      check(
        builtinNames.includes(name),
        `安装后内置技能不可发现: ${name}（已发现: ${builtinNames.join('、')}）`,
      );
    }
    check(
      builtinNames.length >= expectedBuiltin.length,
      `安装后内置技能数量不足: ${builtinNames.join('、')}`,
    );
  } finally {
    rmSync(smokeDir, { recursive: true, force: true });
  }

  // 还原 package.json（去掉临时注入的 file: 依赖），恢复开发期 workspace 软链
  writeFileSync(join(ROOT, 'package.json'), originalRootPkg);

  console.log(
    `✓ 打包验证通过（${tarballName}，${entries.length} 个文件条目；bin / 源码 / 无 dist / 安装冒烟全部达标）`,
  );
}

main();
