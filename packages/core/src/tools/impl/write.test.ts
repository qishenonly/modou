import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProtocolEvent } from '../../protocol/events';
import { runToolPipeline } from '../pipeline';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { defaultWriteTools } from './index';
import { editTool } from './edit';
import { writeSchema, writeTool } from './write';

/**
 * Write 工具测试（T-030）：全部离线，fixture 都写在临时目录（os.tmpdir()），
 * 不读仓库外的任何既有路径。防盲写通过注入 ctx.readFiles（已读文件集合）验证。
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

interface WritePayload {
  readonly path: string;
  readonly existed: boolean;
  readonly bytesWritten: number;
  readonly overwrite: boolean;
  readonly error?: string;
  readonly parentDir?: string;
}

function payloadOf(outcome: { readonly payload?: unknown }): WritePayload {
  return outcome.payload as WritePayload;
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
  tmpDir = mkdtempSync(join(tmpdir(), 'modou-write-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeTool 基本形态', () => {
  test('工具名 / 风险 / 描述 / schema 合理', () => {
    expect(writeTool.name).toBe('write');
    expect(writeTool.risk).toBe('write');
    expect(writeTool.description.length).toBeGreaterThan(20);
    expect(writeTool.description).toContain('overwrite');
    expect(writeTool.description).toContain('Read');
    expect(writeTool.schema).toBe(writeSchema);
  });

  test('schema：path / content 必填，overwrite 可选 boolean', () => {
    expect(writeSchema.safeParse({ path: 'a.ts', content: 'x' }).success).toBe(
      true,
    );
    expect(
      writeSchema.safeParse({ path: 'a.ts', content: 'x', overwrite: true })
        .success,
    ).toBe(true);
    expect(writeSchema.safeParse({ path: 'a.ts', content: '' }).success).toBe(
      true, // 空内容允许（新建空文件）
    );
    expect(writeSchema.safeParse({}).success).toBe(false); // 都必填
    expect(writeSchema.safeParse({ path: '', content: 'x' }).success).toBe(
      false,
    );
    expect(writeSchema.safeParse({ path: 'a.ts' }).success).toBe(false); // content 必填
    expect(
      writeSchema.safeParse({ path: 'a.ts', content: 'x', overwrite: 'yes' })
        .success,
    ).toBe(false);
    expect(writeSchema.safeParse({ path: 'a.ts', content: 42 }).success).toBe(
      false,
    );
  });

  test('defaultWriteTools：注册 read / grep / glob / write / edit / bash 并幂等', () => {
    const registry = defaultWriteTools();
    expect(registry.has('read')).toBe(true);
    expect(registry.has('grep')).toBe(true);
    expect(registry.has('glob')).toBe(true);
    expect(registry.has('write')).toBe(true);
    expect(registry.has('edit')).toBe(true);
    expect(registry.has('bash')).toBe(true);
    expect(registry.find('write')).toBe(writeTool);
    expect(registry.find('edit')).toBe(editTool);
    // 幂等：再次装配不重复注册、不抛错
    const again = defaultWriteTools(registry);
    expect(again.size).toBe(6);
    // 可继续在同一注册表上叠加其他工具
    const custom = new ToolRegistry();
    defaultWriteTools(custom);
    expect(custom.has('write')).toBe(true);
    expect(custom.has('edit')).toBe(true);
  });
});

describe('新建文件', () => {
  test('新建成功：内容落盘、payload 字段完整（existed=false）', async () => {
    const p = fixturePath('new.txt');
    const out = await writeTool.execute(
      { path: p, content: '第一行\n第二行' },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('第一行\n第二行');

    const payload = payloadOf(out);
    expect(payload.path).toBe(p);
    expect(payload.existed).toBe(false);
    expect(payload.bytesWritten).toBe(
      Buffer.byteLength('第一行\n第二行', 'utf8'),
    );
    expect(payload.overwrite).toBe(false);
    expect(payload.error).toBeUndefined();
    expect(out.forModel).toContain('新建');
    expect(out.forModel).toContain(String(payload.bytesWritten));
  });

  test('新建空文件：bytesWritten=0，内容为空', async () => {
    const p = fixturePath('empty.txt');
    const out = await writeTool.execute({ path: p, content: '' }, makeCtx());
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('');
    expect(payloadOf(out).bytesWritten).toBe(0);
    expect(payloadOf(out).existed).toBe(false);
  });

  test('相对路径相对 cwd 解析，输出解析后的绝对路径', async () => {
    const out = await writeTool.execute(
      { path: 'rel.txt', content: '内容' },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
    const p = fixturePath('rel.txt');
    expect(readFileSync(p, 'utf8')).toBe('内容');
    expect(payloadOf(out).path).toBe(p);
  });

  test('新建不要求已读集合：新文件不受防盲写限制', async () => {
    const p = fixturePath('fresh.ts');
    const out = await writeTool.execute(
      { path: p, content: 'const a = 1;' },
      makeCtx(tmpDir, new Set()),
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('const a = 1;');
  });

  test('原子写：成功后目录里不留临时文件', async () => {
    const p = fixturePath('atomic.txt');
    const out = await writeTool.execute(
      { path: p, content: 'data' },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
    expect(leftoverTempFiles(tmpDir)).toEqual([]);
  });
});

describe('防盲写与覆盖语义', () => {
  test('覆盖未读过的文件被拒：ok=false 可诊断，原内容不变', async () => {
    const p = writeFixture('keep.txt', '原内容');
    const out = await writeTool.execute(
      { path: p, content: '新内容', overwrite: true },
      makeCtx(tmpDir, new Set()), // 已读集合为空：本会话未读过
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('未读取过');
    expect(out.forModel).toContain(p);
    expect(out.forModel).toContain('Read');
    const payload = payloadOf(out);
    expect(payload.error).toBe('not_read_before_overwrite');
    expect(payload.path).toBe(p);
    expect(readFileSync(p, 'utf8')).toBe('原内容'); // 未被改动
  });

  test('ctx.readFiles 缺省（未注入）时同样拒绝覆盖', async () => {
    const p = writeFixture('keep2.txt', '原内容');
    const out = await writeTool.execute(
      { path: p, content: '新内容', overwrite: true },
      makeCtx(), // readFiles 未提供
    );
    expect(out.ok).toBe(false);
    expect(payloadOf(out).error).toBe('not_read_before_overwrite');
    expect(readFileSync(p, 'utf8')).toBe('原内容');
  });

  test('读过之后可覆盖：readFiles 含目标即放行，内容被替换', async () => {
    const p = writeFixture('editable.ts', 'const a = 1;');
    const out = await writeTool.execute(
      { path: p, content: 'const a = 2;', overwrite: true },
      makeCtx(tmpDir, new Set([p])), // 本会话已读过该文件
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('const a = 2;');

    const payload = payloadOf(out);
    expect(payload.existed).toBe(true);
    expect(payload.overwrite).toBe(true);
    expect(payload.bytesWritten).toBe(
      Buffer.byteLength('const a = 2;', 'utf8'),
    );
    expect(out.forModel).toContain('覆盖已有文件');
  });

  test('覆盖未读但 overwrite=false：拒绝覆盖（未显式同意）', async () => {
    const p = writeFixture('keep3.txt', '原内容');
    const out = await writeTool.execute(
      { path: p, content: '新内容' }, // 未传 overwrite
      makeCtx(tmpDir, new Set([p])), // 已读过也没用：未显式同意覆盖
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('已存在');
    expect(out.forModel).toContain('overwrite');
    expect(payloadOf(out).error).toBe('exists_requires_overwrite');
    expect(readFileSync(p, 'utf8')).toBe('原内容');
  });

  test('已读且 overwrite=false：同样拒绝（显式同意是硬条件）', async () => {
    const p = writeFixture('keep4.txt', '原内容');
    const out = await writeTool.execute(
      { path: p, content: '新内容', overwrite: false },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(false);
    expect(payloadOf(out).error).toBe('exists_requires_overwrite');
    expect(readFileSync(p, 'utf8')).toBe('原内容');
  });
});

describe('错误即数据', () => {
  test('父目录不存在：可诊断（含缺失父目录与建议）', async () => {
    const p = fixturePath(join('no', 'such', 'dir', 'f.txt'));
    const out = await writeTool.execute({ path: p, content: 'x' }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('父目录');
    expect(out.forModel).toContain(join('no', 'such', 'dir'));
    expect(out.forModel).toContain('mkdir');
    const payload = payloadOf(out);
    expect(payload.error).toBe('parent_not_found');
    expect(payload.parentDir).toBe(join(tmpDir, 'no', 'such', 'dir'));
    expect(payload.path).toBe(p);
  });

  test('路径是目录：拒绝写入并提示换文件路径', async () => {
    const dir = fixturePath('adir');
    mkdirSync(dir);
    const out = await writeTool.execute({ path: dir, content: 'x' }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('目录');
    expect(payloadOf(out).error).toBe('is_directory');
  });

  test('中间路径是文件：回 parent_not_directory', async () => {
    const file = writeFixture('blocker.txt', '我是一个文件');
    const p = join(file, 'child.txt'); // blocker.txt 是文件，不是目录
    const out = await writeTool.execute({ path: p, content: 'x' }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('不是目录');
    expect(payloadOf(out).error).toBe('parent_not_directory');
  });

  test('写入阶段权限不足：回 permission_denied，不抛异常（chmod 只读目录，需非 root）', async () => {
    const dir = fixturePath('locked');
    mkdirSync(dir);
    const p = join(dir, 'out.txt');
    chmodSync(dir, 0o500); // 只读目录：可读可遍历，不可创建文件
    const out = await writeTool.execute({ path: p, content: 'x' }, makeCtx());
    chmodSync(dir, 0o755); // 还原，便于清理
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('权限');
    expect(payloadOf(out).error).toBe('permission_denied');
    expect(leftoverTempFiles(dir)).toEqual([]); // 临时文件被清理
  });
});

describe('payload 结构', () => {
  test('成功 payload：新建 / 覆盖两种形态字段完整', async () => {
    const p = writeFixture('payload.ts', '旧');
    // 覆盖（已读 + overwrite）
    const out = await writeTool.execute(
      { path: p, content: '新旧', overwrite: true },
      makeCtx(tmpDir, new Set([p])),
    );
    expect(out.ok).toBe(true);
    expect(payloadOf(out)).toEqual({
      path: p,
      existed: true,
      bytesWritten: 6, // '新旧' 各 3 字节
      overwrite: true,
    });
  });

  test('失败 payload：error 码 + path（+ parentDir）', async () => {
    const p = fixturePath(join('missing', 'dir', 'f.ts'));
    const out = await writeTool.execute({ path: p, content: 'x' }, makeCtx());
    expect(out.ok).toBe(false);
    expect(payloadOf(out)).toMatchObject({
      path: p,
      error: 'parent_not_found',
      parentDir: join(tmpDir, 'missing', 'dir'),
    });
  });
});

describe('经管线集成', () => {
  test('runToolPipeline：write 成功，tool_result 事件携带 payload', async () => {
    const registry = defaultWriteTools();
    const events: ProtocolEvent[] = [];
    const p = fixturePath('pipe.txt');
    const out = await runToolPipeline(
      { id: 'call-w1', name: 'write', input: { path: p, content: '管道写入' } },
      { registry, emit: (e) => events.push(e), context: { cwd: tmpDir } },
    );

    expect(out.ok).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('管道写入');
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results).toHaveLength(1);
    const result = results[0];
    if (result.type === 'tool_result') {
      expect(result.data.ok).toBe(true);
      expect(result.data.payload).toMatchObject({
        path: p,
        existed: false,
        bytesWritten: Buffer.byteLength('管道写入', 'utf8'),
      });
    }
  });

  test('runToolPipeline：覆盖未读文件经管线同样被拒（readFiles 经 context 注入）', async () => {
    const registry = defaultWriteTools();
    const p = writeFixture('pipe-keep.txt', '原内容');
    const out = await runToolPipeline(
      {
        id: 'call-w2',
        name: 'write',
        input: { path: p, content: '新内容', overwrite: true },
      },
      {
        registry,
        context: { cwd: tmpDir, readFiles: new Set() }, // 已读集合为空
      },
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('未读取过');
    expect(readFileSync(p, 'utf8')).toBe('原内容');
  });

  test('runToolPipeline：参数校验失败回可诊断错误', async () => {
    const registry = defaultWriteTools();
    const out = await runToolPipeline(
      { id: 'call-w3', name: 'write', input: { path: 'a.ts' } }, // 缺 content
      { registry, context: { cwd: tmpDir } },
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('参数校验失败');
    expect(out.forModel).toContain('content');
  });
});
