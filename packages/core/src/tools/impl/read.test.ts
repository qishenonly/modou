import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProtocolEvent } from '../../protocol/events';
import { runToolPipeline } from '../pipeline';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { createReadTool, defaultReadTools, readSchema, readTool } from './read';

/**
 * Read 工具测试（T-021）：全部离线，fixture 都写在临时目录（os.tmpdir()），
 * 不读仓库外的任何既有路径。权限用例依赖非 root 运行（chmod 才生效）。
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

/** 构造 ToolContext：默认 cwd = 临时目录，signal 未中断。 */
function makeCtx(cwd: string = tmpDir): ToolContext {
  return { signal: new AbortController().signal, cwd };
}

interface ReadPayload {
  readonly path: string;
  readonly totalLines: number | null;
  readonly totalBytes: number;
  readonly offset: number;
  readonly limit: number;
  readonly lines: ReadonlyArray<{
    readonly line: number;
    readonly text: string;
  }>;
  readonly largeFile: boolean;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
  /** 错误载荷（成功时不存在）：结构化错误码与附加信息。 */
  readonly error?: string;
  readonly size?: number;
  readonly maxBytes?: number;
}

function payloadOf(outcome: { readonly payload?: unknown }): ReadPayload {
  return outcome.payload as ReadPayload;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'modou-read-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('readTool 基本形态', () => {
  test('工具名 / 风险 / 描述 / schema 合理', () => {
    expect(readTool.name).toBe('read');
    expect(readTool.risk).toBe('read');
    expect(readTool.description.length).toBeGreaterThan(20);
    expect(readTool.description).toContain('path');
    expect(readTool.schema).toBe(readSchema);
  });

  test('schema：path 必填、offset/limit 为正整数、limit 有上限', () => {
    expect(readSchema.safeParse({ path: 'a.ts' }).success).toBe(true);
    expect(
      readSchema.safeParse({ path: 'a.ts', offset: 3, limit: 7 }).success,
    ).toBe(true);
    expect(readSchema.safeParse({}).success).toBe(false); // path 必填
    expect(readSchema.safeParse({ path: '' }).success).toBe(false);
    expect(readSchema.safeParse({ path: 'a.ts', offset: 0 }).success).toBe(
      false,
    );
    expect(readSchema.safeParse({ path: 'a.ts', offset: 1.5 }).success).toBe(
      false,
    );
    expect(readSchema.safeParse({ path: 'a.ts', limit: -1 }).success).toBe(
      false,
    );
    expect(readSchema.safeParse({ path: 'a.ts', limit: 0 }).success).toBe(
      false,
    );
    expect(readSchema.safeParse({ path: 'a.ts', limit: 5000 }).success).toBe(
      false,
    ); // 超上限
  });

  test('defaultReadTools：注册 read 并幂等', () => {
    const registry = defaultReadTools();
    expect(registry.has('read')).toBe(true);
    expect(registry.find('read')).toBe(readTool);
    // 幂等：再次装配不重复注册、不抛错
    const again = defaultReadTools(registry);
    expect(again.size).toBe(1);
    // 可继续在同一注册表上叠加其他工具
    const custom = new ToolRegistry();
    defaultReadTools(custom);
    expect(custom.has('read')).toBe(true);
  });
});

describe('行号与分页', () => {
  test('行号正确：默认读取全部（≤ limit）', async () => {
    const p = writeFixture('a.ts', '第一行\n第二行\n第三行');
    const out = await readTool.execute({ path: p }, makeCtx());
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain('1 | 第一行');
    expect(out.forModel).toContain('2 | 第二行');
    expect(out.forModel).toContain('3 | 第三行');
    expect(out.forModel).toContain('全部内容');

    const payload = payloadOf(out);
    expect(payload.totalLines).toBe(3);
    expect(payload.lines).toEqual([
      { line: 1, text: '第一行' },
      { line: 2, text: '第二行' },
      { line: 3, text: '第三行' },
    ]);
  });

  test('offset/limit 分页：只返回目标行段并提示下一页', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
    const p = writeFixture('p.txt', lines.join('\n'));

    const out = await readTool.execute(
      { path: p, offset: 5, limit: 3 },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain('5 | line-5');
    expect(out.forModel).toContain('7 | line-7');
    expect(out.forModel).not.toContain('line-8');
    expect(out.forModel).toContain('更多行在第 8 行起');
    expect(out.forModel).toContain('offset=8');

    const payload = payloadOf(out);
    expect(payload.lines).toHaveLength(3);
    expect(payload.lines[0]).toEqual({ line: 5, text: 'line-5' });
    expect(payload.lines[2]).toEqual({ line: 7, text: 'line-7' });
    expect(payload.nextOffset).toBe(8);
    expect(payload.truncated).toBe(true);
    expect(out.truncated?.truncated).toBe(true);
    expect(out.truncated?.omittedLines).toBe(17); // 20 行 - 已显示 3 行
  });

  test('行号对齐：多位行号左补空格', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `l${i + 1}`);
    const p = writeFixture('pad.txt', lines.join('\n'));
    // 一页内同时出现一位数与两位数行号（9..13），应左对齐为「 9 |」…「13 |」
    const out = await readTool.execute(
      { path: p, offset: 9, limit: 5 },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain(' 9 | l9');
    expect(out.forModel).toContain('13 | l13');
  });

  test('末页：读到文件尾后不再提示更多行', async () => {
    const p = writeFixture('tail.txt', ['a', 'b', 'c', 'd'].join('\n'));
    const out = await readTool.execute(
      { path: p, offset: 3, limit: 5 },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain('已显示第 3–4 行');
    expect(out.forModel).toContain('全部内容');
    expect(out.forModel).not.toContain('更多行');
    expect(payloadOf(out).nextOffset).toBeNull();
    expect(out.truncated).toBeUndefined(); // 无省略时工具不自报截断信息
  });

  test('越界 offset：回可诊断错误（含总行数与有效范围）', async () => {
    const p = writeFixture('s.txt', ['a', 'b', 'c', 'd', 'e'].join('\n'));
    const out = await readTool.execute({ path: p, offset: 10 }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('共 5 行');
    expect(out.forModel).toContain('offset=10');
    expect(out.forModel).toContain('越界');
    expect(out.forModel).toContain('1..5');
    const payload = payloadOf(out);
    expect(payload.error).toBe('offset_out_of_range');
  });

  test('空文件：ok=true 且提示文件为空', async () => {
    const p = writeFixture('empty.txt', '');
    const out = await readTool.execute({ path: p }, makeCtx());
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain('文件为空');
    const payload = payloadOf(out);
    expect(payload.totalLines).toBe(0);
    expect(payload.lines).toEqual([]);
  });

  test('相对路径相对 cwd 解析，输出解析后的绝对路径', async () => {
    writeFixture('rel.txt', '内容');
    const out = await readTool.execute({ path: 'rel.txt' }, makeCtx());
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain(fixturePath('rel.txt'));
  });

  test('CRLF：行尾 \\r 被剥掉', async () => {
    const p = writeFixture('crlf.txt', 'a\r\nb\r\nc');
    const out = await readTool.execute({ path: p }, makeCtx());
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain('1 | a');
    expect(out.forModel).toContain('2 | b');
    expect(out.forModel).not.toContain('\r');
  });
});

describe('大文件保护', () => {
  test('超过行数阈值：不整读，只返回页面并说明总大小', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `row-${i + 1}`);
    const p = writeFixture('big.txt', lines.join('\n'));
    const tool = createReadTool({ largeFileLines: 50, defaultLimit: 20 });

    const out = await tool.execute({ path: p }, makeCtx());
    expect(out.ok).toBe(true);

    const payload = payloadOf(out);
    expect(payload.largeFile).toBe(true);
    expect(payload.totalLines).toBeNull(); // 未统计全部行数
    expect(payload.lines).toHaveLength(20); // 只读页面，不整读
    expect(payload.truncated).toBe(true);
    expect(payload.nextOffset).toBe(21);

    expect(out.forModel).toContain('未统计全部行数');
    expect(out.forModel).toContain('总大小');
    expect(out.forModel).toContain('offset=21');
    expect(out.forModel).not.toContain('row-21'); // 页面之外的没进输出
  });

  test('超过字节上限：直接拒绝并提示用 Grep', async () => {
    const p = writeFixture('huge.txt', 'x'.repeat(100));
    const tool = createReadTool({ maxBytes: 16 });
    const out = await tool.execute({ path: p }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('过大');
    expect(out.forModel).toContain('Grep');
    const payload = payloadOf(out);
    expect(payload.error).toBe('too_large');
    expect(payload.size).toBe(100);
  });
});

describe('二进制识别', () => {
  test('含 NUL 字节的文件被拒绝，不 dump 乱码', async () => {
    const p = fixturePath('bin.dat');
    writeFileSync(
      p,
      Buffer.from([0x68, 0x69, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64, 0x0a]),
    );
    const out = await readTool.execute({ path: p }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('二进制');
    expect(out.forModel).toContain('Grep');
    const payload = payloadOf(out);
    expect(payload.error).toBe('binary');
  });

  test('硬控制字节（0x07 BEL）同样被拒绝', async () => {
    const p = fixturePath('ctl.dat');
    writeFileSync(p, Buffer.from([0x41, 0x07, 0x42]));
    const out = await readTool.execute({ path: p }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('二进制');
  });

  test('UTF-8 中文不被误判为二进制', async () => {
    const p = writeFixture('cn.txt', '中文注释\n内容 abc');
    const out = await readTool.execute({ path: p }, makeCtx());
    expect(out.ok).toBe(true);
    expect(out.forModel).toContain('1 | 中文注释');
  });
});

describe('错误即数据', () => {
  test('文件不存在：可诊断文本含路径与建议', async () => {
    const out = await readTool.execute(
      { path: fixturePath('nope.ts') },
      makeCtx(),
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('不存在');
    expect(out.forModel).toContain('nope.ts');
    expect(out.forModel).toContain('Glob');
    expect(payloadOf(out).error).toBe('not_found');
  });

  test('目录：明确提示改用 Glob', async () => {
    const dir = fixturePath('adir');
    mkdirSync(dir);
    const out = await readTool.execute({ path: dir }, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('目录');
    expect(out.forModel).toContain('Glob');
    expect(payloadOf(out).error).toBe('is_directory');
  });

  test('无权限：提示权限不足（chmod 000，需非 root 运行）', async () => {
    const p = writeFixture('secret.txt', '敏感内容');
    chmodSync(p, 0o000);
    const out = await readTool.execute({ path: p }, makeCtx());
    chmodSync(p, 0o644); // 还原，便于清理
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('权限');
    expect(payloadOf(out).error).toBe('permission_denied');
  });
});

describe('payload 结构', () => {
  test('成功时 payload 字段完整且类型正确', async () => {
    const p = writeFixture('payload.txt', ['x', 'y', 'z'].join('\n'));
    const out = await readTool.execute({ path: p }, makeCtx());
    expect(out.ok).toBe(true);

    const payload = payloadOf(out);
    expect(payload.path).toBe(p);
    expect(payload.totalLines).toBe(3);
    expect(payload.totalBytes).toBe(5); // "x\ny\nz" = 5 字节
    expect(payload.offset).toBe(1);
    expect(payload.limit).toBe(200); // 默认 limit
    expect(payload.largeFile).toBe(false);
    expect(payload.truncated).toBe(false);
    expect(payload.nextOffset).toBeNull();
    expect(payload.lines).toEqual([
      { line: 1, text: 'x' },
      { line: 2, text: 'y' },
      { line: 3, text: 'z' },
    ]);
  });
});

describe('经管线集成', () => {
  test('runToolPipeline：read 成功，forModel 过脱敏，tool_result 事件携带 payload', async () => {
    const p = writeFixture('pipe.txt', '内容 sk-hunter1234567890 结尾');
    const registry = defaultReadTools();
    const events: ProtocolEvent[] = [];
    const out = await runToolPipeline(
      { id: 'call-1', name: 'read', input: { path: p } },
      { registry, emit: (e) => events.push(e), context: { cwd: tmpDir } },
    );

    expect(out.ok).toBe(true);
    expect(out.forModel).toContain('sk-[REDACTED]');
    expect(out.forModel).not.toContain('sk-hunter1234567890');

    const results = events.filter((event) => event.type === 'tool_result');
    expect(results).toHaveLength(1);
    const result = results[0];
    if (result.type === 'tool_result') {
      expect(result.data.ok).toBe(true);
      expect(result.data.payload).toMatchObject({ path: p, totalLines: 1 });
    }
  });

  test('runToolPipeline：参数校验失败回可诊断错误', async () => {
    const registry = defaultReadTools();
    const out = await runToolPipeline(
      { id: 'call-2', name: 'read', input: { path: 'a.ts', offset: 0 } },
      { registry, context: { cwd: tmpDir } },
    );
    expect(out.ok).toBe(false);
    expect(out.forModel).toContain('参数校验失败');
    expect(out.forModel).toContain('offset');
  });
});

describe('onFileRead 上报（会话已读集合的生产者）', () => {
  test('成功读取：回调收到 realpath 解析后的绝对路径', async () => {
    const p = writeFixture('report.txt', '内容');
    const reported: string[] = [];
    const out = await readTool.execute(
      { path: p },
      {
        signal: new AbortController().signal,
        cwd: tmpDir,
        onFileRead: (path) => reported.push(path),
      },
    );
    expect(out.ok).toBe(true);
    // 入集合的是 realpath 解析后的真实路径（符号链接 / /var→/private/var 归一化），
    // 使后续 Write/Edit 的 realpath 归一化检查能命中。
    expect(reported).toEqual([realpathSync(p)]);
  });

  test('失败（文件不存在）：回调不被调用', async () => {
    const reported: string[] = [];
    const out = await readTool.execute(
      { path: fixturePath('missing.txt') },
      {
        signal: new AbortController().signal,
        cwd: tmpDir,
        onFileRead: (path) => reported.push(path),
      },
    );
    expect(out.ok).toBe(false);
    expect(reported).toEqual([]);
  });

  test('未注入 onFileRead：静默不调用（可选回调）', async () => {
    const p = writeFixture('quiet.txt', '内容');
    const out = await readTool.execute({ path: p }, makeCtx());
    expect(out.ok).toBe(true);
  });
});
