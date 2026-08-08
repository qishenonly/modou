/**
 * T-131 结构化日志（JSONL）离线测试。
 *
 * 覆盖：
 * - StructuredLogger：追加写 JSONL，行序与调用顺序一致，可 flush 后逐行解析；
 * - EnvelopeLogAdapter：事件流 → 三类条目——usage → request（token 分项 +
 *   provider/model）、tool_call+tool_result → tool_call（工具名 + 结果状态）、
 *   approval_request+approval_resolved → permission（裁决 + 依据）；
 * - 写失败不抛出：onError 上报（不静默），append 的 promise 仍 resolve；
 * - close 后丢弃新条目。
 *
 * 全部离线：临时目录落盘，不碰真实 ~/.modou。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Envelope } from '../protocol/events';
import {
  EnvelopeLogAdapter,
  StructuredLogger,
} from './structured';

/** 构造一个测试信封（公共字段齐全，data 按需）。 */
function envelope(
  type: Envelope['type'],
  data: Record<string, unknown>,
  overrides: Partial<Pick<Envelope, 'turn' | 'agent'>> = {},
): Envelope {
  return {
    v: 1,
    seq: 1,
    ts: 1_700_000_000_000,
    agent: overrides.agent ?? 'main',
    turn: overrides.turn ?? 1,
    type,
    data,
  } as Envelope;
}

/** 读取 JSONL 文件并逐行解析（文件不存在 = 无条目）。 */
function readEntries(file: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const tmpDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'modou-structured-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('StructuredLogger（T-131 JSONL 追加写）', () => {
  test('append 落盘为可解析的 JSONL，行序与调用顺序一致', async () => {
    const dir = tempDir();
    const logger = new StructuredLogger({ dir, filename: 'test.jsonl' });
    await logger.append({ type: 'request', ts: 1, turn: 1, agent: 'main', provider: 'stub', model: 'm', inputTokens: 10, outputTokens: 5 });
    await logger.append({ type: 'tool_call', ts: 2, turn: 1, agent: 'main', id: 'c1', tool: 'bash', ok: true, summary: 'done' });
    await logger.flush();

    const entries = readEntries(join(dir, 'test.jsonl'));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: 'request', model: 'm', inputTokens: 10 });
    expect(entries[1]).toMatchObject({ type: 'tool_call', tool: 'bash', ok: true });
    // 每条都带 ts（logger 注入）且可整体 JSON 化
    expect(entries.every((entry) => typeof entry.ts === 'number')).toBe(true);
    expect(() => JSON.stringify(entries)).not.toThrow();
  });

  test('写失败不抛出：onError 收到错误（不静默），append 仍 resolve', async () => {
    const dir = tempDir();
    const errors: unknown[] = [];
    // 用「目录本身当作文件名」触发 EISDIR 写失败
    const logger = new StructuredLogger({
      dir,
      filename: 'subdir',
      onError: (error) => errors.push(error),
    });
    // 先建同名目录：appendFile 写目录必失败
    const fs = await import('node:fs');
    fs.mkdirSync(join(dir, 'subdir'), { recursive: true });
    await logger.append({ type: 'request', ts: 1, turn: 1, agent: 'main', provider: 'stub', model: 'm' });
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors[0])).toContain('EISDIR');
  });

  test('close 后丢弃新条目', async () => {
    const dir = tempDir();
    const logger = new StructuredLogger({ dir, filename: 'test.jsonl' });
    await logger.append({ type: 'request', ts: 1, turn: 1, agent: 'main', provider: 'stub', model: 'm' });
    await logger.close();
    await logger.append({ type: 'tool_call', ts: 2, turn: 1, agent: 'main', id: 'x', tool: 'bash', ok: false });
    await logger.flush();
    const entries = readEntries(join(dir, 'test.jsonl'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'request' });
  });
});

describe('EnvelopeLogAdapter（T-131 事件流 → 日志条目）', () => {
  test('usage → request（token 分项 + provider/model）', async () => {
    const dir = tempDir();
    const logger = new StructuredLogger({ dir, filename: 'test.jsonl' });
    const adapter = new EnvelopeLogAdapter(logger, { provider: 'openai-compat', model: 'deepseek-v4-flash' });

    adapter.consume(
      envelope('usage', {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 90,
        noCacheTokens: 30,
        cacheHitRate: 0.75,
      }),
    );
    await logger.flush();

    const entries = readEntries(join(dir, 'test.jsonl'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'request',
      turn: 1,
      agent: 'main',
      provider: 'openai-compat',
      model: 'deepseek-v4-flash',
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 90,
      cacheHitRate: 0.75,
    });
  });

  test('tool_call + tool_result → tool_call（工具名跨事件关联）', async () => {
    const dir = tempDir();
    const logger = new StructuredLogger({ dir, filename: 'test.jsonl' });
    const adapter = new EnvelopeLogAdapter(logger, { provider: 'stub', model: 'm' });

    adapter.consume(envelope('tool_call', { id: 'c1', name: 'bash', input: { cmd: 'ls' } }));
    adapter.consume(envelope('tool_result', { id: 'c1', ok: false, summary: '失败' }));
    await logger.flush();

    const entries = readEntries(join(dir, 'test.jsonl'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'tool_call',
      id: 'c1',
      tool: 'bash',
      ok: false,
      summary: '失败',
    });
    // 入参不进日志（默认脱敏——只记名称与结果，不记工具入参）
    expect(JSON.stringify(entries[0])).not.toContain('cmd');
  });

  test('approval_request + approval_resolved → permission（裁决 + 依据）', async () => {
    const dir = tempDir();
    const logger = new StructuredLogger({ dir, filename: 'test.jsonl' });
    const adapter = new EnvelopeLogAdapter(logger, { provider: 'stub', model: 'm' });

    adapter.consume(
      envelope(
        'approval_request',
        { id: 'r1', description: '执行命令：ls', risk: 'exec', options: [] },
        { turn: 2 },
      ),
    );
    adapter.consume(
      envelope(
        'approval_resolved',
        { id: 'r1', decision: 'deny', source: 'policy' },
        { turn: 2 },
      ),
    );
    await logger.flush();

    const entries = readEntries(join(dir, 'test.jsonl'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'permission',
      turn: 2,
      requestId: 'r1',
      risk: 'exec',
      decision: 'deny',
      source: 'policy',
      operation: '执行命令：ls',
    });
  });

  test('未匹配事件类型直接跳过（非错误）', async () => {
    const dir = tempDir();
    const logger = new StructuredLogger({ dir, filename: 'test.jsonl' });
    const adapter = new EnvelopeLogAdapter(logger, { provider: 'stub', model: 'm' });
    adapter.consume(envelope('text_delta', { delta: '你好' }));
    adapter.consume(envelope('turn_end', { turn: 1, termination: 'end_turn' }));
    await logger.flush();
    expect(readEntries(join(dir, 'test.jsonl'))).toHaveLength(0);
  });
});
