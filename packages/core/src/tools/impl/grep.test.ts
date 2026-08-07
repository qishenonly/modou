import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolContext } from '../types';
import { createGrepTool, grepSchema, grepTool } from './grep';
import { defaultReadonlyTools } from './index';

/**
 * Grep 工具测试（T-022）：全部离线，fixture 写在临时目录（os.tmpdir()），
 * 用真实 rg（默认走捆绑 @vscode/ripgrep，测试环境已安装）验证行为；
 * rg 不可用等分支用注入（rgOptions）模拟，不依赖外部环境。
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

interface GrepMatchLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly clipped: boolean;
  readonly submatches: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }>;
}

interface GrepFileGroup {
  readonly path: string;
  readonly matchCount: number;
  readonly lines: ReadonlyArray<GrepMatchLine>;
}

interface GrepPayload {
  readonly pattern: string;
  readonly path: string;
  readonly glob?: string;
  readonly ignoreCase: boolean;
  readonly totalMatches?: number;
  readonly fileCount?: number;
  readonly files?: ReadonlyArray<GrepFileGroup>;
  readonly truncated?: boolean;
  readonly error?: string;
}

function payloadOf(outcome: { readonly payload?: unknown }): GrepPayload {
  return outcome.payload as GrepPayload;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'modou-grep-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('grepTool 基本形态', () => {
  test('工具名 / 风险 / 描述 / schema 合理', () => {
    expect(grepTool.name).toBe('grep');
    expect(grepTool.risk).toBe('read');
    expect(grepTool.description.length).toBeGreaterThan(20);
    expect(grepTool.description).toContain('pattern');
    expect(grepTool.description).toContain('glob');
    expect(grepTool.schema).toBe(grepSchema);
  });

  test('schema：pattern 必填、path/glob 可选、maxResults 有上限', () => {
    expect(grepSchema.safeParse({ pattern: 'foo' }).success).toBe(true);
    expect(
      grepSchema.safeParse({
        pattern: 'foo',
        path: 'src',
        glob: '**/*.ts',
        ignoreCase: true,
        maxResults: 10,
      }).success,
    ).toBe(true);
    expect(grepSchema.safeParse({}).success).toBe(false); // pattern 必填
    expect(grepSchema.safeParse({ pattern: '' }).success).toBe(false);
    expect(grepSchema.safeParse({ pattern: 'foo', path: '' }).success).toBe(
      false,
    );
    expect(
      grepSchema.safeParse({ pattern: 'foo', ignoreCase: 'yes' }).success,
    ).toBe(false);
    expect(
      grepSchema.safeParse({ pattern: 'foo', maxResults: 0 }).success,
    ).toBe(false);
    expect(
      grepSchema.safeParse({ pattern: 'foo', maxResults: 5000 }).success,
    ).toBe(false); // 超上限
  });

  test('defaultReadonlyTools：注册 read / grep / glob 并幂等', () => {
    const registry = defaultReadonlyTools();
    expect(registry.has('read')).toBe(true);
    expect(registry.has('grep')).toBe(true);
    expect(registry.has('glob')).toBe(true);
    expect(registry.find('grep')).toBe(grepTool);
    // 幂等：再次装配不重复注册、不抛错
    const again = defaultReadonlyTools(registry);
    expect(again.size).toBe(3);
  });
});

describe('命中与聚组', () => {
  test('命中：返回文件 + 行号 + 文本片段，按文件聚组', async () => {
    writeFixture('a.ts', 'export const foo = 1;\nconst other = 2;\nfoo();');
    writeFixture('b.ts', 'const foo = 3;');
    writeFixture('c.md', 'foo 在文档里');

    const out = await grepTool.execute(
      { pattern: 'foo', glob: '**/*.ts' },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
    // forModel 对基准目录下的命中显示相对路径（可读性好），payload 才是绝对路径
    expect(out.forModel).toContain('a.ts（2 处命中）');
    expect(out.forModel).toContain('1 | export const foo = 1;');
    expect(out.forModel).toContain('3 | foo();');
    expect(out.forModel).toContain('b.ts（1 处命中）');

    const payload = payloadOf(out);
    expect(payload.totalMatches).toBe(3);
    expect(payload.fileCount).toBe(2);
    expect(payload.glob).toBe('**/*.ts');
    // 文件按路径排序
    expect(payload.files?.map((f) => f.path)).toEqual([
      fixturePath('a.ts'),
      fixturePath('b.ts'),
    ]);
    expect(payload.files?.[0].matchCount).toBe(2);
    expect(payload.files?.[1].matchCount).toBe(1);
    expect(payload.files?.[0].lines[0]).toMatchObject({
      lineNumber: 1,
      text: 'export const foo = 1;',
      clipped: false,
    });
    // 子匹配区间：foo 在行内的字节区间（"export const foo..." 中 foo 起于 13、止于 16）
    expect(payload.files?.[0].lines[0].submatches[0]).toMatchObject({
      text: 'foo',
      start: 13,
      end: 16,
    });
  });

  test('默认路径 = cwd：不传 path 也能在 cwd 下搜索', async () => {
    writeFixture('x.ts', 'needle 在这里');
    const out = await grepTool.execute({ pattern: 'needle' }, makeCtx());
    expect(out.ok).toBe(true);
    expect(payloadOf(out).path).toBe(tmpDir);
    expect(out.forModel).toContain('x.ts（1 处命中）');
  });

  test('path 指向单个文件也可搜索', async () => {
    const p = writeFixture('single.txt', 'aaa\nbbb needle\nccc');
    const out = await grepTool.execute(
      { pattern: 'needle', path: p },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
    expect(payloadOf(out).path).toBe(p);
    expect(out.forModel).toContain('2 | bbb needle');
  });

  test('片段裁剪：超长行保留前 N 字符并标记 clipped', async () => {
    writeFixture('long.ts', `prefix ${'x'.repeat(200)} suffix`);
    const tool = createGrepTool({ snippetMax: 20 });
    const out = await tool.execute({ pattern: 'prefix' }, makeCtx());
    expect(out.ok).toBe(true);
    const payload = payloadOf(out);
    const line = payload.files?.[0].lines[0];
    expect(line?.clipped).toBe(true);
    expect(line?.text.length).toBe(20);
    expect(line?.text.startsWith('prefix xxxxx')).toBe(true);
    // 裁剪后子匹配区间丢弃（偏移已失真）
    expect(line?.submatches).toEqual([]);
  });
});

describe('ignoreCase 与 glob 过滤', () => {
  test('ignoreCase=false 区分大小写，=true 忽略', async () => {
    writeFixture('case.ts', 'Hello World\n');
    const strict = await grepTool.execute({ pattern: 'hello' }, makeCtx());
    expect(strict.ok).toBe(false);
    expect(payloadOf(strict).error).toBe('no_match');

    const loose = await grepTool.execute(
      { pattern: 'hello', ignoreCase: true },
      makeCtx(),
    );
    expect(loose.ok).toBe(true);
    expect(loose.forModel).toContain('1 | Hello World');
    expect(payloadOf(loose).ignoreCase).toBe(true);
  });

  test('glob 过滤：只搜命中 glob 的文件', async () => {
    writeFixture('a.ts', 'foo in ts');
    writeFixture('b.md', 'foo in md');
    const out = await grepTool.execute(
      { pattern: 'foo', glob: '**/*.ts' },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain('a.ts');
    expect(out.forModel).not.toContain('b.md');
    expect(payloadOf(out).fileCount).toBe(1);
  });
});

describe('错误即数据', () => {
  test('无匹配：可诊断文本含下一步建议（ignoreCase / 更宽泛 pattern / 确认路径）', async () => {
    writeFixture('a.ts', 'nothing here');
    const out = await grepTool.execute({ pattern: 'zzz_nope' }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('未找到');
    expect(out.forModel).toContain('ignoreCase');
    expect(out.forModel).toContain('更宽泛');
    const payload = payloadOf(out);
    expect(payload.error).toBe('no_match');
    expect(payload.pattern).toBe('zzz_nope');
  });

  test('无匹配且带 glob：提示检查 glob 过滤', async () => {
    writeFixture('a.ts', 'nothing here');
    const out = await grepTool.execute(
      { pattern: 'zzz', glob: '**/*.ts' },
      makeCtx(),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('glob');
  });

  test('路径不存在：可诊断文本含路径与建议', async () => {
    const out = await grepTool.execute(
      { pattern: 'foo', path: fixturePath('nope') },
      makeCtx(),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('不存在');
    expect(out.forModel).toContain('nope');
    expect(payloadOf(out).error).toBe('not_found');
  });

  test('无效正则：rg 报 regex parse error，映射为 pattern 无效', async () => {
    writeFixture('a.ts', 'content');
    const out = await grepTool.execute({ pattern: '[' }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('pattern 无效');
    expect(payloadOf(out).error).toBe('rg_error');
  });

  test('rg 不可用（注入）：可诊断文本含安装指引', async () => {
    const tool = createGrepTool({
      rgOptions: { bundledPath: null, systemPath: null },
    });
    const out = await tool.execute({ pattern: 'foo' }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('ripgrep');
    expect(out.forModel).toContain('安装');
    expect(payloadOf(out).error).toBe('rg_unavailable');
  });
});

describe('maxResults 截断', () => {
  test('超过上限：明确提示「已截断，仅显示前 N 条命中」', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `hit-${i + 1}`);
    writeFixture('many.ts', lines.join('\n'));
    const out = await grepTool.execute(
      { pattern: 'hit', maxResults: 5 },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain('已截断：仅显示前 5 条命中');
    expect(out.forModel).toContain('hit-1');
    expect(out.forModel).not.toContain('hit-6'); // 5 条之后的没进输出
    const payload = payloadOf(out);
    expect(payload.truncated).toBe(true);
    expect(payload.totalMatches).toBe(5);
    expect(out.truncated?.truncated).toBe(true);
  });
});

describe('gitignore 默认排除', () => {
  test('有 .git 仓库时，rg 默认跳过 .gitignore 排除的目录', async () => {
    // rg 只在 git 仓库内尊重 .gitignore（.git 目录存在即识别），fixture 里建一个空的
    mkdirSync(fixturePath('.git'));
    writeFixture('.gitignore', 'ignored/\n');
    writeFixture('visible.ts', 'foo 可见');
    writeFixture('ignored/hidden.ts', 'foo 被忽略');

    const out = await grepTool.execute({ pattern: 'foo' }, makeCtx());
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain('visible.ts');
    expect(out.forModel).not.toContain('hidden.ts');
    expect(payloadOf(out).fileCount).toBe(1);
  });
});
