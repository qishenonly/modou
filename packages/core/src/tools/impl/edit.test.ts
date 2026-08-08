import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProtocolEvent } from '../../protocol/events';
import { runToolPipeline } from '../pipeline';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { defaultWriteTools } from './index';
import { createEditTool, editSchema, editTool } from './edit';

/**
 * Edit 工具测试（T-031）：全部离线，fixture 都写在临时目录（os.tmpdir()），
 * 不读仓库外的任何既有路径。防盲写通过注入 ctx.readFiles（已读文件集合）验证。
 * 重点：错误信息质量——0 次匹配的相似片段诊断、多次匹配的位置列表与 replace_all
 * 提示，均构造专门用例验证诊断对模型「一次修好」确实有用。
 */

let tmpDir: string;

function fixturePath(name: string): string {
  return join(tmpDir, name);
}

function writeFixture(name: string, content: string): string {
  const p = fixturePath(name);
  writeFileSync(p, content, 'utf8');
  return p;
}

interface EditPayload {
  readonly path: string;
  readonly replaced: boolean;
  readonly occurrenceCount: number;
  readonly matches?: ReadonlyArray<{ line: number; context: string }>;
  readonly newBytes?: number;
  readonly error?: string;
  readonly suggestion?: { line: number; snippet: string; difference: string };
  readonly old_string?: string;
  readonly new_string?: string;
}

function payloadOf(outcome: { readonly payload?: unknown }): EditPayload {
  return outcome.payload as EditPayload;
}

/** 构造 ToolContext：默认 cwd = 临时目录、signal 未中断、已读集合可注入。 */
function makeCtx(
  cwd: string = tmpDir,
  readFiles?: ReadonlySet<string>,
): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd,
    ...(readFiles !== undefined ? { readFiles } : {}),
  };
}

/** 列出目标目录下残留的原子写临时文件（.modou-*.tmp）。 */
function leftoverTempFiles(dir: string): string[] {
  return readdirSync(dir).filter(
    (name) => name.includes('.modou-') && name.endsWith('.tmp'),
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'modou-edit-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('editTool 基本形态', () => {
  test('工具名 / 风险 / 描述 / schema 合理', () => {
    expect(editTool.name).toBe('edit');
    expect(editTool.risk).toBe('write');
    expect(editTool.description.length).toBeGreaterThan(20);
    expect(editTool.description).toContain('old_string');
    expect(editTool.description).toContain('replace_all');
    expect(editTool.description).toContain('Read');
    expect(editTool.schema).toBe(editSchema);
  });

  test('schema：path / old_string / new_string 必填，replace_all 可选 boolean', () => {
    expect(
      editSchema.safeParse({ path: 'a.ts', old_string: 'x', new_string: 'y' })
        .success,
    ).toBe(true);
    expect(
      editSchema.safeParse({
        path: 'a.ts',
        old_string: 'x',
        new_string: '',
        replace_all: true,
      }).success,
    ).toBe(true); // new_string 可为空串（删除）；replace_all 可选 boolean
    expect(editSchema.safeParse({}).success).toBe(false); // 都必填
    expect(
      editSchema.safeParse({ path: 'a.ts', old_string: 'x' }).success,
    ).toBe(
      false, // new_string 必填
    );
    expect(
      editSchema.safeParse({ path: 'a.ts', new_string: 'y' }).success,
    ).toBe(false); // old_string 必填
    expect(
      editSchema.safeParse({ path: '', old_string: 'x', new_string: 'y' })
        .success,
    ).toBe(false);
    expect(
      editSchema.safeParse({ path: 'a.ts', old_string: '', new_string: 'y' })
        .success,
    ).toBe(false); // old_string 不能为空串
    expect(
      editSchema.safeParse({
        path: 'a.ts',
        old_string: 42,
        new_string: 'y',
      }).success,
    ).toBe(false);
    expect(
      editSchema.safeParse({
        path: 'a.ts',
        old_string: 'x',
        new_string: 'y',
        replace_all: 'yes',
      }).success,
    ).toBe(false);
  });
});

describe('唯一匹配替换成功', () => {
  test('单行替换成功：内容更新、payload 字段完整（replaced=true, occurrenceCount=1）', async () => {
    const p = writeFixture('solo.txt', '第一行\n第二行\n第三行');
    const out = await editTool.execute(
      { path: p, old_string: '第二行', new_string: '已修改' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('第一行\n已修改\n第三行');

    const payload = payloadOf(out);
    expect(payload.path).toBe(p);
    expect(payload.replaced).toBe(true);
    expect(payload.occurrenceCount).toBe(1);
    expect(payload.newBytes).toBe(
      Buffer.byteLength('第一行\n已修改\n第三行', 'utf8'),
    );
    expect(payload.error).toBeUndefined();
    expect(payload.matches).toBeUndefined();
    expect(out.forModel).toContain('已替换');
    expect(out.forModel).toContain('第 2 行');
  });

  test('多行 old_string / new_string 替换成功', async () => {
    const p = writeFixture('multi.ts', 'function f() {\n  return 1;\n}\n');
    const out = await editTool.execute(
      {
        path: p,
        old_string: 'function f() {\n  return 1;\n}',
        new_string: 'function g() {\n  return 2;\n}',
      },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('function g() {\n  return 2;\n}\n');
    expect(payloadOf(out).occurrenceCount).toBe(1);
    expect(payloadOf(out).replaced).toBe(true);
    expect(out.forModel).toContain('第 1 行');
  });

  test('new_string 传空字符串 = 删除片段', async () => {
    const p = writeFixture('del.txt', 'a\nb\nc\n');
    const out = await editTool.execute(
      { path: p, old_string: 'b\n', new_string: '' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('a\nc\n');
  });

  test('相对路径相对 cwd 解析，输出解析后的绝对路径', async () => {
    const p = writeFixture('rel.txt', 'hello world');
    const out = await editTool.execute(
      { path: 'rel.txt', old_string: 'world', new_string: 'modou' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('hello modou');
    expect(payloadOf(out).path).toBe(p);
  });
});

describe('0 次匹配：相似片段诊断', () => {
  test('差异在缩进：返回最相近片段、行号与「缩进」提示', async () => {
    const p = writeFixture(
      'indent.ts',
      'function sum(a, b) {\n    return a + b;\n}\n',
    );
    const out = await editTool.execute(
      {
        path: p,
        old_string: '      return a + b;',
        new_string: '  return a + b;',
      }, // 6 空格缩进，文件是 4 空格（不是子串，必不匹配）
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('未找到精确匹配');
    expect(out.forModel).toContain('最相近的片段在第 2 行附近');
    expect(out.forModel).toContain('return a + b');
    expect(out.forModel).toContain('缩进'); // 差异提示落在「缩进」
    expect(out.forModel).toContain('Read'); // 给出下一步建议

    const payload = payloadOf(out);
    expect(payload.error).toBe('no_match');
    expect(payload.occurrenceCount).toBe(0);
    expect(payload.suggestion).toBeDefined();
    expect(payload.suggestion?.line).toBe(2);
    expect(payload.suggestion?.difference).toContain('缩进');
  });

  test('差异在标点：提示「字符不同」并给出两侧上下文', async () => {
    const p = writeFixture('quote.ts', 'const greeting = "hello";');
    const out = await editTool.execute(
      {
        path: p,
        old_string: "const greeting = 'hello';",
        new_string: 'const greeting = "hi";',
      }, // 单引号，文件是双引号
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('最相近的片段在第 1 行附近');
    expect(out.forModel).toContain('字符不同');
    expect(payloadOf(out).error).toBe('no_match');
    expect(payloadOf(out).suggestion?.difference).toContain('字符不同');
  });

  test('差异在大小写：提示「大小写不同」', async () => {
    const p = writeFixture('case.ts', 'export function FooBar(): void {}');
    const out = await editTool.execute(
      {
        path: p,
        old_string: 'export function foobar(): void {}',
        new_string: 'export function FooBar(): void {}',
      },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('大小写不同');
    expect(payloadOf(out).suggestion?.difference).toContain('大小写');
  });

  test('空文件：明确告知无内容可匹配，建议用 Write', async () => {
    const p = writeFixture('empty.txt', '');
    const out = await editTool.execute(
      { path: p, old_string: 'x', new_string: 'y' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('为空');
    expect(out.forModel).toContain('Write');
    expect(payloadOf(out).error).toBe('no_match');
  });

  test('没有相近内容：不硬凑「最相近」，如实说明共享字符太少', async () => {
    const p = writeFixture('unrelated.txt', 'foo bar baz');
    const out = await editTool.execute(
      { path: p, old_string: 'zzz zzz', new_string: 'yyy yyy' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('共享字符太少');
    expect(out.forModel).not.toContain('最相近的片段'); // 不应给出误导性候选
    expect(payloadOf(out).suggestion).toBeUndefined();
  });
});

describe('多次匹配：匹配不唯一', () => {
  test('列出各位置（行号 + 上下文）并提示 replace_all 或补充上下文', async () => {
    const p = writeFixture(
      'dup.ts',
      'const a = 1;\nconst b = 2;\nconst a = 1;\n',
    );
    const out = await editTool.execute(
      { path: p, old_string: 'const a = 1;', new_string: 'const a = 9;' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('出现 2 次');
    expect(out.forModel).toContain('> 1 | const a = 1;'); // 匹配位置行号 + 上下文
    expect(out.forModel).toContain('> 3 | const a = 1;');
    expect(out.forModel).toContain('replace_all');

    const payload = payloadOf(out);
    expect(payload.error).toBe('ambiguous_match');
    expect(payload.replaced).toBe(false);
    expect(payload.occurrenceCount).toBe(2);
    expect(payload.matches).toHaveLength(2);
    expect(payload.matches?.[0].line).toBe(1);
    expect(payload.matches?.[1].line).toBe(3);
    expect(readFileSync(p, 'utf8')).toBe(
      'const a = 1;\nconst b = 2;\nconst a = 1;\n', // 未被改动
    );
  });

  test('replace_all=true 替换全部匹配', async () => {
    const p = writeFixture(
      'dup-all.ts',
      'const a = 1;\nconst b = 2;\nconst a = 1;\n',
    );
    const out = await editTool.execute(
      {
        path: p,
        old_string: 'const a = 1;',
        new_string: 'const a = 9;',
        replace_all: true,
      },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe(
      'const a = 9;\nconst b = 2;\nconst a = 9;\n',
    );
    const payload = payloadOf(out);
    expect(payload.replaced).toBe(true);
    expect(payload.occurrenceCount).toBe(2);
    expect(payload.newBytes).toBe(
      Buffer.byteLength('const a = 9;\nconst b = 2;\nconst a = 9;\n', 'utf8'),
    );
    expect(out.forModel).toContain('已全部替换');
  });

  test('replace_all=true 且恰好 1 次匹配：照常替换', async () => {
    const p = writeFixture('one.ts', 'let x = 1;');
    const out = await editTool.execute(
      {
        path: p,
        old_string: 'let x = 1;',
        new_string: 'let x = 2;',
        replace_all: true,
      },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('let x = 2;');
    expect(payloadOf(out).occurrenceCount).toBe(1);
  });
});

describe('防盲写', () => {
  test('未读过的文件被拒：ok=false 可诊断，文件不被改动', async () => {
    const p = writeFixture('keep.ts', 'old content');
    const out = await editTool.execute(
      { path: p, old_string: 'old content', new_string: 'new content' },
      makeCtx(tmpDir, new Set()), // 已读集合为空
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('未读取过');
    expect(out.forModel).toContain('Read');
    expect(out.forModel).toContain(p);
    expect(payloadOf(out).error).toBe('not_read_before_edit');
    expect(readFileSync(p, 'utf8')).toBe('old content');
  });

  test('ctx.readFiles 缺省（未注入）时同样拒绝', async () => {
    const p = writeFixture('keep2.ts', 'old');
    const out = await editTool.execute(
      { path: p, old_string: 'old', new_string: 'new' },
      makeCtx(), // readFiles 未提供
    );
    expect(out.ok).toBe(false);
    expect(payloadOf(out).error).toBe('not_read_before_edit');
  });

  test('已读后放行：readFiles 含目标即替换', async () => {
    const p = writeFixture('editable.ts', 'const a = 1;');
    const out = await editTool.execute(
      { path: p, old_string: 'const a = 1;', new_string: 'const a = 2;' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('const a = 2;');
  });

  test('符号链接目标：readFiles 命中 realpath 即放行（realpath 归一化）', async () => {
    const real = writeFixture('real.ts', 'const a = 1;');
    const link = fixturePath('link.ts');
    symlinkSync(real, link);
    const out = await editTool.execute(
      { path: link, old_string: 'const a = 1;', new_string: 'const a = 3;' },
      // 已读集合里是链接指向的真实文件路径，而非链接路径本身
      makeCtx(tmpDir, new Set([realpathSync(real)])),
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('const a = 3;');
  });
});

describe('错误即数据', () => {
  test('文件不存在：可诊断（含路径与建议）', async () => {
    const p = fixturePath('nope.ts');
    const out = await editTool.execute(
      { path: p, old_string: 'x', new_string: 'y' },
      makeCtx(),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('不存在');
    expect(out.forModel).toContain(p);
    expect(out.forModel).toContain('Write'); // 提示新建用 Write
    expect(payloadOf(out).error).toBe('not_found');
  });

  test('路径是目录：拒绝并提示换文件路径', async () => {
    const dir = fixturePath('adir');
    mkdirSync(dir);
    const out = await editTool.execute(
      { path: dir, old_string: 'x', new_string: 'y' },
      makeCtx(),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('目录');
    expect(payloadOf(out).error).toBe('is_directory');
  });

  test('old_string 为空字符串（运行期防御）：拒绝并解释', async () => {
    const p = writeFixture('guard.ts', 'hello');
    const out = await editTool.execute(
      { path: p, old_string: '', new_string: 'x' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('不能为空字符串');
    expect(payloadOf(out).error).toBe('old_string_empty');
    expect(readFileSync(p, 'utf8')).toBe('hello');
  });

  test('大文件保护：超过 maxBytes 拒绝（maxBytes 可注入）', async () => {
    const tool = createEditTool({ maxBytes: 100 });
    const p = writeFixture('big.txt', 'x'.repeat(200));
    const out = await tool.execute(
      { path: p, old_string: 'xxx', new_string: 'yyy' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('过大');
    expect(out.forModel).toContain('Grep');
    expect(payloadOf(out).error).toBe('too_large');
    expect(readFileSync(p, 'utf8')).toBe('x'.repeat(200)); // 未被改动
  });

  test('疑似二进制（NUL 字节）：拒绝文本编辑', async () => {
    const p = writeFixture('bin.dat', 'abc\0def');
    const out = await editTool.execute(
      { path: p, old_string: 'abc', new_string: 'xyz' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('二进制');
    expect(payloadOf(out).error).toBe('binary');
    expect(readFileSync(p, 'utf8')).toBe('abc\0def');
  });
});

describe('payload 结构', () => {
  test('成功 payload：replaced / occurrenceCount / newBytes 字段完整', async () => {
    const p = writeFixture('payload.ts', 'const v = 1;');
    const out = await editTool.execute(
      { path: p, old_string: 'const v = 1;', new_string: 'const v = 2;' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(true);
    expect(payloadOf(out)).toEqual({
      path: p,
      replaced: true,
      occurrenceCount: 1,
      newBytes: Buffer.byteLength('const v = 2;', 'utf8'),
      old_string: 'const v = 1;',
      new_string: 'const v = 2;',
    });
  });

  test('失败 payload：error 码 + path + 诊断字段', async () => {
    const p = writeFixture(
      'diag.ts',
      'function sum(a, b) {\n    return a + b;\n}\n',
    );
    const out = await editTool.execute(
      {
        path: p,
        old_string: '      return a + b;',
        new_string: '  return a + b;',
      }, // 6 空格缩进，文件是 4 空格
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(false);
    expect(payloadOf(out)).toMatchObject({
      path: p,
      replaced: false,
      occurrenceCount: 0,
      error: 'no_match',
    });
    expect(payloadOf(out).suggestion).toMatchObject({
      line: 2,
      difference: expect.stringContaining('缩进'),
    });
  });
});

describe('原子写', () => {
  test('替换后保留原文件权限位（mode）', async () => {
    const p = writeFixture('mode.txt', '原内容');
    chmodSync(p, 0o640);
    const out = await editTool.execute(
      { path: p, old_string: '原内容', new_string: '新内容' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('新内容');
    expect(statSync(p).mode & 0o777).toBe(0o640);
  });

  test('原子写：成功后目录里不留临时文件', async () => {
    const p = writeFixture('atomic.txt', 'before');
    const out = await editTool.execute(
      { path: p, old_string: 'before', new_string: 'after' },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(true);
    expect(leftoverTempFiles(tmpDir)).toEqual([]);
  });
});

describe('经管线集成', () => {
  test('runToolPipeline：edit 成功，tool_result 事件携带 payload', async () => {
    const registry = defaultWriteTools();
    const events: ProtocolEvent[] = [];
    const p = writeFixture('pipe.ts', 'const a = 1;');
    const out = await runToolPipeline(
      {
        id: 'call-e1',
        name: 'edit',
        input: {
          path: p,
          old_string: 'const a = 1;',
          new_string: 'const a = 5;',
        },
      },
      {
        registry,
        emit: (e) => events.push(e),
        context: { cwd: tmpDir, readFiles: new Set([p]) },
      },
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('const a = 5;');
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results).toHaveLength(1);
    const result = results[0];
    if (result.type === 'tool_result') {
      expect(result.data.ok).toBe(true);
      expect(result.data.payload).toMatchObject({
        path: p,
        replaced: true,
        occurrenceCount: 1,
      });
    }
  });

  test('runToolPipeline：未读文件经管线同样被拒（readFiles 经 context 注入）', async () => {
    const registry = defaultWriteTools();
    const p = writeFixture('pipe-keep.ts', '原内容');
    const out = await runToolPipeline(
      {
        id: 'call-e2',
        name: 'edit',
        input: { path: p, old_string: '原内容', new_string: '新内容' },
      },
      { registry, context: { cwd: tmpDir, readFiles: new Set() } },
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('未读取过');
    expect(readFileSync(p, 'utf8')).toBe('原内容');
  });

  test('runToolPipeline：参数校验失败回可诊断错误', async () => {
    const registry = defaultWriteTools();
    const out = await runToolPipeline(
      { id: 'call-e3', name: 'edit', input: { path: 'a.ts', old_string: 'x' } }, // 缺 new_string
      { registry, context: { cwd: tmpDir } },
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('参数校验失败');
    expect(out.forModel).toContain('new_string');
  });

  test('defaultWriteTools 注册 edit 且幂等', () => {
    const registry = defaultWriteTools();
    expect(registry.has('edit')).toBe(true);
    expect(registry.find('edit')).toBe(editTool);
    const again = defaultWriteTools(registry);
    expect(again.size).toBe(8); // read / grep / glob / write / edit / bash / todo_write / task
    // 可继续在同一注册表上叠加其他工具
    const custom = new ToolRegistry();
    defaultWriteTools(custom);
    expect(custom.has('edit')).toBe(true);
  });
});
