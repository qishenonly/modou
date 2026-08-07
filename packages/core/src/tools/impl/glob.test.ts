import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolContext } from '../types';
import { createGlobTool, globSchema, globTool } from './glob';

/**
 * Glob 工具测试（T-022）：全部离线，fixture 写在临时目录（os.tmpdir()），
 * 用真实 rg（默认走捆绑 @vscode/ripgrep）验证枚举与 mtime 排序；
 * rg 不可用等分支用注入（rgOptions）模拟。
 */

let tmpDir: string;

function fixturePath(name: string): string {
  return join(tmpDir, name);
}

function writeFixture(name: string, content: string): string {
  const p = fixturePath(name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
  return p;
}

/** 构造 ToolContext：默认 cwd = 临时目录，signal 未中断。 */
function makeCtx(cwd: string = tmpDir): ToolContext {
  return { signal: new AbortController().signal, cwd };
}

interface GlobPayload {
  readonly pattern: string;
  readonly path: string;
  readonly totalFiles?: number;
  readonly files?: ReadonlyArray<string>;
  readonly truncated?: boolean;
  readonly omittedFiles?: number;
  readonly collectCapped?: boolean;
  readonly error?: string;
  readonly detail?: string;
}

function payloadOf(outcome: { readonly payload?: unknown }): GlobPayload {
  return outcome.payload as GlobPayload;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'modou-glob-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('globTool 基本形态', () => {
  test('工具名 / 风险 / 描述 / schema 合理', () => {
    expect(globTool.name).toBe('glob');
    expect(globTool.risk).toBe('read');
    expect(globTool.description.length).toBeGreaterThan(20);
    expect(globTool.description).toContain('pattern');
    expect(globTool.schema).toBe(globSchema);
  });

  test('schema：pattern 必填、path 可选、maxResults 有上限', () => {
    expect(globSchema.safeParse({ pattern: '**/*.ts' }).success).toBe(true);
    expect(
      globSchema.safeParse({ pattern: '**/*.ts', path: 'src', maxResults: 5 })
        .success,
    ).toBe(true);
    expect(globSchema.safeParse({}).success).toBe(false); // pattern 必填
    expect(globSchema.safeParse({ pattern: '' }).success).toBe(false);
    expect(globSchema.safeParse({ pattern: '**/*.ts', path: '' }).success).toBe(
      false,
    );
    expect(
      globSchema.safeParse({ pattern: '**/*.ts', maxResults: 0 }).success,
    ).toBe(false);
    expect(
      globSchema.safeParse({ pattern: '**/*.ts', maxResults: 5000 }).success,
    ).toBe(false); // 超上限
  });
});

describe('匹配与排序', () => {
  test('按 glob 枚举文件：payload 为绝对路径列表', async () => {
    writeFixture('a.ts', 'a');
    writeFixture('b.ts', 'b');
    writeFixture('c.txt', 'c');
    const out = await globTool.execute({ pattern: '**/*.ts' }, makeCtx());
    expect(out.ok).toBe(true);
    const payload = payloadOf(out);
    expect(payload.totalFiles).toBe(2);
    expect(payload.files).toHaveLength(2);
    expect(payload.files).toContain(fixturePath('a.ts'));
    expect(payload.files).toContain(fixturePath('b.ts'));
    expect(payload.files).not.toContain(fixturePath('c.txt'));
    // forModel 展示文件（相对 cwd 或绝对路径）
    expect(out.forModel).toContain('共 2 个文件');
  });

  test('结果按修改时间排序（最新在前）', async () => {
    const pA = writeFixture('a.ts', 'a');
    const pB = writeFixture('b.ts', 'b');
    const pC = writeFixture('c.ts', 'c');
    const now = Date.now();
    utimesSync(pA, new Date(now), new Date(now - 30_000)); // 最旧
    utimesSync(pB, new Date(now), new Date(now - 20_000));
    utimesSync(pC, new Date(now), new Date(now - 10_000)); // 最新

    const out = await globTool.execute({ pattern: '**/*.ts' }, makeCtx());
    expect(out.ok).toBe(true);
    const payload = payloadOf(out);
    expect(payload.files).toEqual([pC, pB, pA]);
  });

  test('默认路径 = cwd：不传 path 也能在 cwd 下枚举', async () => {
    writeFixture('x.ts', 'x');
    const out = await globTool.execute({ pattern: '**/*.ts' }, makeCtx());
    expect(out.ok).toBe(true);
    expect(payloadOf(out).path).toBe(tmpDir);
    expect(out.forModel).toContain('x.ts');
  });

  test('相对路径相对 cwd 解析', async () => {
    mkdirSync(fixturePath('src'));
    writeFixture('src/nested.ts', 'n');
    const out = await globTool.execute(
      { pattern: '**/*.ts', path: 'src' },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
    expect(payloadOf(out).path).toBe(fixturePath('src'));
    expect(payloadOf(out).files).toContain(fixturePath('src/nested.ts'));
  });
});

describe('错误即数据', () => {
  test('无匹配：可诊断文本含 glob 语法 / 大小写 / ignore 提示', async () => {
    writeFixture('a.ts', 'a');
    const out = await globTool.execute({ pattern: '**/*.xyz' }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('未找到');
    expect(out.forModel).toContain('glob 语法');
    expect(out.forModel).toContain('大小写');
    expect(payloadOf(out).error).toBe('no_match');
  });

  test('路径不存在：可诊断文本含路径与建议', async () => {
    const out = await globTool.execute(
      { pattern: '**/*.ts', path: fixturePath('nope') },
      makeCtx(),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('不存在');
    expect(payloadOf(out).error).toBe('not_found');
  });

  test('路径是文件：提示 Glob 只能枚举目录', async () => {
    const p = writeFixture('a.ts', 'a');
    const out = await globTool.execute(
      { pattern: '**/*.ts', path: p },
      makeCtx(),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('不是目录');
    expect(payloadOf(out).error).toBe('not_a_directory');
  });

  test('无效 glob：rg 报错映射为可诊断文本', async () => {
    writeFixture('a.ts', 'a');
    const out = await globTool.execute({ pattern: '[' }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('rg 执行失败');
    expect(payloadOf(out).error).toBe('rg_error');
  });

  test('rg 不可用（注入）：可诊断文本含安装指引', async () => {
    const tool = createGlobTool({
      rgOptions: { bundledPath: null, systemPath: null },
    });
    const out = await tool.execute({ pattern: '**/*.ts' }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('ripgrep');
    expect(out.forModel).toContain('安装');
    expect(payloadOf(out).error).toBe('rg_unavailable');
  });
});

describe('maxResults 截断', () => {
  test('超过上限：明确提示「已截断，仅显示前 N 个文件」并给省略数', async () => {
    for (let i = 1; i <= 30; i += 1) {
      writeFixture(`f${i}.ts`, 'x');
    }
    const out = await globTool.execute(
      { pattern: '**/*.ts', maxResults: 5 },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain('已截断：仅显示前 5 个文件');
    expect(out.forModel).toContain('省略 25 个');
    const payload = payloadOf(out);
    expect(payload.truncated).toBe(true);
    expect(payload.omittedFiles).toBe(25);
    expect(payload.totalFiles).toBe(30);
    expect(payload.files).toHaveLength(5);
    expect(out.truncated?.truncated).toBe(true);
  });
});

describe('gitignore 默认排除', () => {
  test('有 .git 仓库时，rg 默认跳过 .gitignore 排除的目录', async () => {
    mkdirSync(fixturePath('.git'));
    writeFixture('.gitignore', 'ignored/\n');
    writeFixture('visible.ts', 'v');
    writeFixture('ignored/hidden.ts', 'h');

    const out = await globTool.execute({ pattern: '**/*.ts' }, makeCtx());
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain('visible.ts');
    expect(out.forModel).not.toContain('hidden.ts');
    expect(payloadOf(out).totalFiles).toBe(1);
  });
});
