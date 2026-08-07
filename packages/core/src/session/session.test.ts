import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProviderCapabilities } from '../provider/capabilities';
import { ProviderError } from '../provider/errors';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
  TokenUsage,
} from '../provider/types';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import { runAgentTurn } from '../runtime/loop';
import type { RuntimeEvent } from '../runtime/loop';
import { projectHash, SessionLog, SessionLogError } from './log';
import { SessionStore } from './store';

// ---------------------------------------------------------------------------
// 测试替身：StubProvider —— 完全本地、不访问外网的假 ModelProvider
// （与 runtime.test.ts 的替身同构，本文件自持一份）。
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

class StubProvider implements ModelProvider {
  readonly id = 'stub';
  readonly modelId = 'stub-model';
  readonly capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES;
  private callCount = 0;

  constructor(private readonly rounds: StreamEvent[][]) {}

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    const round = this.rounds[Math.min(this.callCount, this.rounds.length - 1)];
    this.callCount += 1;
    for (const event of round) {
      if (input.abortSignal?.aborted) {
        throw new ProviderError({ kind: 'aborted', message: '请求已被中断' });
      }
      yield event;
    }
  }
}

/** 纯文本轮：逐字符 text_delta → usage → finish(stop)。 */
function textEvents(
  text: string,
  usage: TokenUsage = { inputTokens: 10, outputTokens: 5 },
): StreamEvent[] {
  const events: StreamEvent[] = Array.from(text).map((char) => ({
    type: 'text_delta',
    delta: char,
  }));
  events.push({ type: 'usage', usage });
  events.push({ type: 'finish', reason: 'stop' });
  return events;
}

/** 工具调用轮：tool_use → usage → finish(tool_use)。 */
function toolUseEvents(
  name = 'echo',
  id = 'call-1',
  input: unknown = { text: '你好' },
): StreamEvent[] {
  return [
    { type: 'tool_use', id, name, input },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: 'tool_use' },
  ];
}

/** 测试用 stub 工具：回显入参。 */
const echoTool: Tool = {
  name: 'echo',
  description: '原样返回输入的文本（测试用）',
  risk: 'read',
  schema: z.object({ text: z.string().min(1) }),
  execute: async (args: { text: string }) => ({
    ok: true,
    forModel: `echo:${args.text}`,
  }),
};

/** 构造一个临时 HOME（测试全部落在这个目录下，绝不触碰真实主目录）。 */
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'modou-session-'));
}

/** 逐行解析 JSONL，返回记录（测试断言前的降级视图）。 */
function parseLines(
  path: string,
): Array<{ seq: number; ts: number; kind: string; data: unknown }> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          seq: number;
          ts: number;
          kind: string;
          data: unknown;
        },
    );
}

// ---------------------------------------------------------------------------
// SessionLog：追加写格式与目录结构
// ---------------------------------------------------------------------------

describe('SessionLog 追加写（T-060）', () => {
  test('追加写：JSON 可解析、seq 递增、ts/kind/data 正确、目录结构符合布局', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      mkdirSync(cwd, { recursive: true });
      const log = new SessionLog({
        homeDir: home,
        cwd,
        now: () => 1_700_000_000_000,
      });
      await log.appendUser('你好');
      await log.appendTurnStart(1);
      await log.appendAssistant({ text: '你好！' });
      await log.appendUsage({ inputTokens: 10, outputTokens: 5 });

      // 目录结构：<home>/.modou/sessions/<project-hash>/<session-id>.jsonl
      const project = projectHash(cwd);
      expect(project).toMatch(/^[0-9a-f]{16}$/);
      const dir = join(home, '.modou', 'sessions', project);
      expect(readdirSync(dir)).toEqual([`${log.sessionId}.jsonl`]);
      expect(log.sessionId).toMatch(/^\d{8}-\d{6}-[a-z0-9]{6}$/);

      // 每行都是合法 JSON；seq 从 1 递增
      const records = parseLines(log.path);
      expect(records).toHaveLength(4);
      expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
      expect(records.every((r) => r.ts === 1_700_000_000_000)).toBe(true);
      expect(records[0]).toEqual({
        seq: 1,
        ts: 1_700_000_000_000,
        kind: 'user',
        data: { text: '你好' },
      });
      expect(records[1]).toEqual({
        seq: 2,
        ts: 1_700_000_000_000,
        kind: 'turn_start',
        data: { turn: 1 },
      });
      expect(records[2]).toEqual({
        seq: 3,
        ts: 1_700_000_000_000,
        kind: 'assistant',
        data: { text: '你好！' },
      });
      expect(records[3]).toEqual({
        seq: 4,
        ts: 1_700_000_000_000,
        kind: 'usage',
        data: { inputTokens: 10, outputTokens: 5 },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('projectHash：同一 cwd 稳定、不同 cwd 不同、与 realpath 归一一致', () => {
    expect(projectHash('/nonexistent/a/b')).toBe(
      projectHash('/nonexistent/a/b'),
    );
    expect(projectHash('/nonexistent/a/b')).not.toBe(
      projectHash('/nonexistent/a/c'),
    );
  });

  test('会话重开：续读既有最大 seq，追加延续编号（append 不重写文件）', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      const log1 = new SessionLog({ homeDir: home, cwd, sessionId: 's1' });
      await log1.appendUser('一');
      await log1.appendAssistant({ text: '二' });

      // 重开同一 session-id：seq 延续，而不是从 1 重来
      const log2 = new SessionLog({ homeDir: home, cwd, sessionId: 's1' });
      expect(log2.seq).toBe(2);
      await log2.appendUser('三');

      const records = parseLines(log1.path);
      expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
      expect(records.map((r) => r.kind)).toEqual(['user', 'assistant', 'user']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('写失败可诊断：onError 收到 SessionLogError（含路径/seq/kind），append 不抛出', async () => {
    const home = tempHome();
    try {
      const errors: SessionLogError[] = [];
      const log = new SessionLog({
        homeDir: home,
        cwd: join(home, 'proj'),
        sessionId: 'fixed-id',
        onError: (error) => {
          errors.push(error);
        },
      });
      // 在目标文件路径上建一个目录：appendFile 触发 EISDIR，且不抛出
      mkdirSync(log.path, { recursive: true });

      await log.appendUser('写不进去');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(SessionLogError);
      expect(errors[0].path).toBe(log.path);
      expect(errors[0].seq).toBe(1);
      expect(errors[0].kind).toBe('user');
      expect(errors[0].underlying).toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SessionStore：列/读/删
// ---------------------------------------------------------------------------

describe('SessionStore（T-060）', () => {
  test('read：坏行跳过并标记行号，有效记录保持顺序', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      const log = new SessionLog({ homeDir: home, cwd });
      await log.appendUser('第一行');
      await log.appendAssistant({ text: '第二行' });

      // 手动注入三种坏行：截断 JSON / 非 JSON / 合法 JSON 但缺 data
      const bad: string[] = [
        '{"seq":3,"ts":1,"kind":"usage","data":{',
        '这不是 JSON',
        '{"seq":4,"ts":1,"kind":"user"}',
      ];
      writeFileSync(
        log.path,
        readFileSync(log.path, 'utf8') +
          bad.map((line) => `${line}\n`).join(''),
        'utf8',
      );

      const store = new SessionStore({ homeDir: home });
      const result = await store.read(projectHash(cwd), log.sessionId);
      expect(result).not.toBeNull();
      if (result === null) throw new Error('read 不应返回 null');
      expect(result.records.map((r) => r.kind)).toEqual(['user', 'assistant']);
      expect(result.records.map((r) => r.seq)).toEqual([1, 2]);
      expect(result.skippedLines).toEqual([3, 4, 5]);

      // 文件不存在 → null
      expect(await store.read(projectHash(cwd), 'no-such-session')).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('list：多会话按时间倒序（末条 ts 降序）', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      let tick = 1000;
      const log1 = new SessionLog({
        homeDir: home,
        cwd,
        now: () => tick++ * 1000,
      });
      await log1.appendUser('一');
      const log2 = new SessionLog({
        homeDir: home,
        cwd,
        now: () => tick++ * 1000,
      });
      await log2.appendUser('二');
      const log3 = new SessionLog({
        homeDir: home,
        cwd,
        now: () => tick++ * 1000,
      });
      await log3.appendUser('三');

      const store = new SessionStore({ homeDir: home });
      const summaries = await store.list(projectHash(cwd));
      expect(summaries.map((s) => s.sessionId)).toEqual([
        log3.sessionId,
        log2.sessionId,
        log1.sessionId,
      ]);
      expect(summaries[0].lastTs).toBeGreaterThan(summaries[1].lastTs);
      expect(summaries[1].lastTs).toBeGreaterThan(summaries[2].lastTs);
      // 摘要字段齐全
      expect(summaries[0]).toMatchObject({
        projectHash: projectHash(cwd),
        entryCount: 1,
        maxSeq: 1,
      });
      expect(
        summaries[0].path.endsWith(`${summaries[0].sessionId}.jsonl`),
      ).toBe(true);

      // projects() 列出含会话的项目
      expect(await store.projects()).toEqual([projectHash(cwd)]);
      // 不存在的项目 → 空数组
      expect(await store.list('a'.repeat(16))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('delete：删除文件并清理空项目目录；重复删除返回 false', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      const log = new SessionLog({ homeDir: home, cwd });
      await log.appendUser('x');

      const store = new SessionStore({ homeDir: home });
      const project = projectHash(cwd);
      expect(await store.read(project, log.sessionId)).not.toBeNull();
      expect(await store.delete(project, log.sessionId)).toBe(true);
      expect(await store.read(project, log.sessionId)).toBeNull();
      expect(await store.delete(project, log.sessionId)).toBe(false);
      // 空项目目录被清理，projects() 不再列出它
      expect(await store.projects()).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('路径安全：非法的 projectHash / sessionId 拒绝（防路径逃逸）', async () => {
    const store = new SessionStore({ homeDir: tempHome() });
    expect(() => store.list('../evil')).toThrow();
    expect(() => store.read('a'.repeat(16), '../secret')).toThrow();
    expect(() => store.delete('a'.repeat(16), '..')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// loop 接入：runAgentTurn 经 session 旁路记录一次真实对话
// ---------------------------------------------------------------------------

describe('runAgentTurn + session（T-060 旁路记录）', () => {
  test('记录完整对话：user → turn_start/usage → assistant(调用) → tool_result → 纯文本 → turn_end', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      const registry = new ToolRegistry().register(echoTool);
      const stub = new StubProvider([
        toolUseEvents('echo', 'call-1', { text: '你好' }),
        textEvents('已收到。'),
      ]);
      const log = new SessionLog({ homeDir: home, cwd, now: () => 5_000 });
      const events: RuntimeEvent[] = [];

      const result = await runAgentTurn(
        {
          provider: stub,
          messages: [{ role: 'user', content: '请回显' }],
          tools: registry,
          session: log,
          options: { maxTurns: 5 },
        },
        (event) => events.push(event),
      );
      expect(result.termination).toBe('end_turn');
      expect(result.text).toBe('已收到。');

      const store = new SessionStore({ homeDir: home });
      const read = await store.read(projectHash(cwd), log.sessionId);
      expect(read).not.toBeNull();
      if (read === null) throw new Error('read 不应返回 null');
      const records = read.records;

      // 条目种类与顺序（9 条）
      expect(records.map((r) => r.kind)).toEqual([
        'user',
        'turn_start',
        'usage',
        'assistant',
        'tool_result',
        'turn_start',
        'usage',
        'assistant',
        'turn_end',
      ]);

      // user 条目：入参 user 消息文本
      expect(records[0]).toMatchObject({
        kind: 'user',
        data: { text: '请回显' },
      });
      // 第一个 assistant 条目：空文本 + 工具调用（入参原样）
      expect(records[3]).toMatchObject({
        kind: 'assistant',
        data: {
          text: '',
          calls: [{ id: 'call-1', name: 'echo', input: { text: '你好' } }],
        },
      });
      // tool_result：管线结果（ok + forModel + summary）
      expect(records[4]).toMatchObject({
        kind: 'tool_result',
        data: { callId: 'call-1', ok: true, forModel: 'echo:你好' },
      });
      // 两次 usage：两轮请求的 token 分项
      expect(records[2]).toMatchObject({
        kind: 'usage',
        data: { inputTokens: 10, outputTokens: 3 },
      });
      expect(records[6]).toMatchObject({
        kind: 'usage',
        data: { inputTokens: 10, outputTokens: 5 },
      });
      // 末轮纯文本：收尾补记 assistant
      expect(records[7]).toMatchObject({
        kind: 'assistant',
        data: { text: '已收到。' },
      });
      // turn_end：轮次与终止原因
      expect(records[8]).toMatchObject({
        kind: 'turn_end',
        data: { turn: 2, termination: 'end_turn' },
      });

      // 事件流语义不变：与既有 turn_start/turn_end 事件一致
      expect(events.filter((e) => e.type === 'turn_start')).toHaveLength(2);
      expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('会话日志的 assistant 调用入参已脱敏（密钥不出现在 JSONL）', async () => {
    const home = tempHome();
    try {
      const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
      const registry = new ToolRegistry().register(echoTool);
      const stub = new StubProvider([
        toolUseEvents('echo', 'call-1', { token: secret }),
        textEvents('明白。'),
      ]);
      const log = new SessionLog({ homeDir: home, cwd: join(home, 'proj') });

      const result = await runAgentTurn({
        provider: stub,
        messages: [{ role: 'user', content: '回显令牌' }],
        tools: registry,
        session: log,
        options: { maxTurns: 5 },
      });
      expect(result.termination).toBe('end_turn');

      // 磁盘上的会话文件不得出现明文密钥（002 5.4 脱敏发生在入日志之前）
      const text = readFileSync(log.path, 'utf8');
      expect(text).not.toContain(secret);
      expect(text).toContain('sk-[REDACTED]');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('不传 session：行为与既有 loop 完全一致（无任何文件产出）', async () => {
    const home = tempHome();
    try {
      const stub = new StubProvider([textEvents('好的')]);
      const events: RuntimeEvent[] = [];
      const result = await runAgentTurn(
        {
          provider: stub,
          messages: [{ role: 'user', content: 'hi' }],
          options: { maxTurns: 5 },
        },
        (event) => events.push(event),
      );
      expect(result.termination).toBe('end_turn');
      // 未注入 session：sessions 根下无任何目录/文件
      expect(existsSync(join(home, '.modou', 'sessions'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('终止为 error：补记 error 条目与 turn_end（部分文本照常入日志）', async () => {
    const home = tempHome();
    try {
      const stub = new StubProvider([
        [
          { type: 'text_delta', delta: '部分' },
          { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
          { type: 'finish', reason: 'error' },
        ],
      ]);
      const log = new SessionLog({ homeDir: home, cwd: join(home, 'proj') });
      const result = await runAgentTurn({
        provider: stub,
        messages: [{ role: 'user', content: '触发错误' }],
        session: log,
        options: { maxTurns: 5 },
      });
      expect(result.termination).toBe('error');

      const records = parseLines(log.path);
      const kinds = records.map((r) => r.kind);
      expect(kinds).toEqual([
        'user',
        'turn_start',
        'usage',
        'assistant',
        'error',
        'turn_end',
      ]);
      // 部分文本入日志 + error 条目可诊断
      expect(records[3]).toMatchObject({
        kind: 'assistant',
        data: { text: '部分' },
      });
      expect(records[4]).toMatchObject({ kind: 'error' });
      expect((records[4].data as { message: string }).message).toContain(
        'content-filter',
      );
      expect(records[5]).toMatchObject({
        kind: 'turn_end',
        data: { turn: 1, termination: 'error' },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
