/**
 * T-132 /init 离线测试。
 *
 * 覆盖：
 * - probeRepository：fixture 仓库探测——技术栈（TypeScript / 框架）、包管理器
 *   （bun / npm / pnpm / yarn）、脚本（test / lint / build）、规范工具
 *   （prettier / eslint / biome）、CI（github-actions / gitlab-ci）、测试模式；
 * - generateAgentsMd：固定模板结构（# AGENTS.md / 项目概览 / 常用命令 / 测试 /
 *   代码规范 / CI / 给 AI 助手的工作约定）+ 探测结果填充；
 * - runInit：写入 `<cwd>/AGENTS.md`；已存在时不覆盖（wrote: false）。
 *
 * 全部离线：临时目录构造 fixture，不访问外网。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAgentsMd, probeRepository, runInit } from './probe';

const tmpDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'modou-init-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 构造一个 bun + TypeScript + eslint/prettier + GitHub Actions 的 fixture。 */
function buildTypeScriptFixture(cwd: string): void {
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-app',
        scripts: {
          test: 'bun test',
          lint: 'eslint .',
          build: 'bun build src/index.ts',
          typecheck: 'tsc --noEmit',
        },
        dependencies: { react: '^18', typescript: '^5' },
        devDependencies: { vitest: '^2' },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(cwd, 'bun.lock'), '{}');
  writeFileSync(join(cwd, 'tsconfig.json'), '{}');
  writeFileSync(join(cwd, '.prettierrc'), '{}');
  writeFileSync(join(cwd, 'eslint.config.js'), 'export default [];');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'index.ts'), 'export const a = 1;\n');
  mkdirSync(join(cwd, 'src', '__tests__'), { recursive: true });
  writeFileSync(
    join(cwd, 'src', '__tests__', 'index.test.ts'),
    'import { describe, expect, test } from "bun:test";\n',
  );
  mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(cwd, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
  writeFileSync(join(cwd, 'README.md'), '# fixture-app\n');
}

describe('probeRepository（T-132 技术栈 / 命令 / 规范 / CI 探测）', () => {
  test('TypeScript + bun + react：语言 / 框架 / 包管理器 / 脚本 / 规范 / CI 全命中', () => {
    const cwd = tempDir();
    buildTypeScriptFixture(cwd);
    const profile = probeRepository(cwd);

    expect(profile.languages).toContain('typescript');
    expect(profile.frameworks).toContain('react');
    expect(profile.packageManager).toBe('bun');
    expect(profile.scripts.test).toBe('bun test');
    expect(profile.scripts.lint).toBe('eslint .');
    expect(profile.scripts.build).toBe('bun build src/index.ts');
    expect(profile.formatters).toContain('prettier');
    expect(profile.linters).toContain('eslint');
    expect(profile.ci).toContain('github-actions');
    expect(profile.hasTypescript).toBe(true);
    expect(profile.hasReadme).toBe(true);
    // 测试模式：__tests__ 目录 + *.test.ts 文件
    expect(profile.testPatterns.some((p) => p.includes('__tests__'))).toBe(
      true,
    );
    expect(profile.testPatterns.some((p) => p.includes('.test.'))).toBe(true);
  });

  test('无 package.json 的 Python 仓库：语言识别 + 测试命令未识别 + note 明确', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'pyproject.toml'), '[project]\n');
    writeFileSync(join(cwd, 'src.py'), 'print(1)\n');
    const profile = probeRepository(cwd);

    expect(profile.languages).toContain('python');
    expect(profile.packageManager).toBe('unknown');
    expect(profile.scripts.test).toBeUndefined();
    expect(profile.testCommandHint).toBeUndefined();
    expect(profile.notes.length).toBeGreaterThan(0);
  });

  test('npm + pnpm 锁文件判定各自正确', () => {
    const npmDir = tempDir();
    writeFileSync(join(npmDir, 'package.json'), JSON.stringify({ name: 'a' }));
    writeFileSync(join(npmDir, 'package-lock.json'), '{}');
    expect(probeRepository(npmDir).packageManager).toBe('npm');

    const pnpmDir = tempDir();
    writeFileSync(join(pnpmDir, 'package.json'), JSON.stringify({ name: 'b' }));
    writeFileSync(join(pnpmDir, 'pnpm-lock.yaml'), '');
    expect(probeRepository(pnpmDir).packageManager).toBe('pnpm');
  });
});

describe('generateAgentsMd（T-132 固定模板 + 探测结果）', () => {
  test('模板包含全部章节；命令与规范填充探测结果', () => {
    const cwd = tempDir();
    buildTypeScriptFixture(cwd);
    const draft = generateAgentsMd(probeRepository(cwd));

    // 标题与固定章节
    expect(draft.startsWith('# AGENTS.md')).toBe(true);
    for (const section of [
      '## 项目概览',
      '## 常用命令',
      '## 测试',
      '## 代码规范',
      '## CI',
      '## 给 AI 助手的工作约定',
    ]) {
      expect(draft).toContain(section);
    }
    // 探测结果填充
    expect(draft).toContain('typescript');
    expect(draft).toContain('bun install');
    expect(draft).toContain('`bun test`');
    expect(draft).toContain('eslint');
    expect(draft).toContain('github-actions');
  });

  test('未识别项明确标注「未识别」而非假装知道', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'pyproject.toml'), '[project]\n');
    const draft = generateAgentsMd(probeRepository(cwd));
    expect(draft).toContain('未识别');
  });
});

describe('runInit（T-132 预览后写入）', () => {
  test('写入 AGENTS.md；已存在时不覆盖', () => {
    const cwd = tempDir();
    buildTypeScriptFixture(cwd);
    const first = runInit(cwd);
    expect(first.wrote).toBe(true);
    expect(first.targetPath).toBe(join(cwd, 'AGENTS.md'));
    expect(existsSync(first.targetPath)).toBe(true);
    const written = readFileSync(first.targetPath, 'utf8');
    expect(written).toBe(first.draft);
    expect(written.startsWith('# AGENTS.md')).toBe(true);

    // 第二次运行：已存在 → 不覆盖
    const second = runInit(cwd);
    expect(second.wrote).toBe(false);
    expect(readFileSync(first.targetPath, 'utf8')).toBe(first.draft);
  });
});
