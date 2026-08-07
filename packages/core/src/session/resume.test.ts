import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProviderCapabilities } from '../provider/capabilities';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
  TokenUsage,
} from '../provider/types';
import { runAgentTurn } from '../runtime/loop';
import { editTool } from '../tools/impl/edit';
import { readTool } from '../tools/impl/read';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import { projectHash, SessionLog } from './log';
import type { SessionRecord, ToolResultEntryData } from './log';
import {
  accumulateUsage,
  countUserMessages,
  listSessionsForResume,
  projectMessages,
  rebuildReadFiles,
  resumeSession,
} from './resume';
import { SessionStore } from './store';

/** 按 callId 找 tool_result 条目（判别联合收窄：直接返回 tool_result 变体）。 */
function findToolResult(
  records: readonly SessionRecord[],
  callId: string,
):
  | { readonly kind: 'tool_result'; readonly data: ToolResultEntryData }
  | undefined {
  for (const record of records) {
    if (record.kind === 'tool_result' && record.data.callId === callId) {
      return record;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 测试替身：StubProvider —— 完全本地、不访问外网的假 ModelProvider
// （与 session.test.ts / runtime.test.ts 同构，本文件自持一份）。
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
        throw new Error('aborted'); // 本文件测试不触发中断，兜底即可
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

/** 测试用 stub 工具：回显入参（readFiles 无关，仅验证消息投影）。 */
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
  return mkdtempSync(join(tmpdir(), 'modou-resume-'));
}

// ---------------------------------------------------------------------------
// projectMessages：日志 → AI SDK ModelMessage 的投影
// ---------------------------------------------------------------------------

describe('projectMessages（T-061 投影）', () => {
  test('工具对话投影：user → assistant(tool-call) → tool → assistant(text)，过程条目被跳过', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      mkdirSync(cwd, { recursive: true });
      const registry = new ToolRegistry().register(echoTool);
      const stub = new StubProvider([
        toolUseEvents('echo', 'call-1', { text: '你好' }),
        textEvents('已收到。'),
      ]);
      const log = new SessionLog({ homeDir: home, cwd });
      const result = await runAgentTurn({
        provider: stub,
        messages: [{ role: 'user', content: '请回显' }],
        tools: registry,
        session: log,
        options: { maxTurns: 5 },
      });
      expect(result.termination).toBe('end_turn');

      const store = new SessionStore({ homeDir: home });
      const read = await store.read(projectHash(cwd), log.sessionId);
      expect(read).not.toBeNull();
      if (read === null) throw new Error('read 不应为 null');

      const projected = projectMessages(read.records);
      expect(projected).toEqual([
        { role: 'user', content: '请回显' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'echo',
              input: { text: '你好' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'echo',
              output: { type: 'text', value: 'echo:你好' },
            },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: '已收到。' }] },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('纯文本两轮对话投影：user / assistant(text) 交替，无 tool 消息', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      mkdirSync(cwd, { recursive: true });
      const log = new SessionLog({ homeDir: home, cwd });
      await log.appendUser('第一问');
      await log.appendTurnStart(1);
      await log.appendAssistant({ text: '第一答' });
      await log.appendUsage({ inputTokens: 3, outputTokens: 2 });
      await log.appendTurnEnd(1, 'end_turn');
      await log.appendUser('第二问');
      await log.appendTurnStart(2);
      await log.appendAssistant({ text: '第二答' });
      await log.appendUsage({ inputTokens: 3, outputTokens: 2 });
      await log.appendTurnEnd(2, 'end_turn');

      const store = new SessionStore({ homeDir: home });
      const read = await store.read(projectHash(cwd), log.sessionId);
      expect(read).not.toBeNull();
      if (read === null) throw new Error('read 不应为 null');
      expect(projectMessages(read.records)).toEqual([
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
        { role: 'user', content: '第二问' },
        { role: 'assistant', content: [{ type: 'text', text: '第二答' }] },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resumeSession：重建 messages / readFiles / usage
// ---------------------------------------------------------------------------

describe('resumeSession（T-061 恢复）', () => {
  test('重建 messages 与记录一致，usage 累计（usage 条目求和）', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      mkdirSync(cwd, { recursive: true });
      const registry = new ToolRegistry().register(echoTool);
      // 两轮：usage {10,3} + {10,5} → 累计 {20,8}
      const stub = new StubProvider([
        toolUseEvents('echo', 'call-1', { text: '你好' }),
        textEvents('已收到。', { inputTokens: 10, outputTokens: 5 }),
      ]);
      const log = new SessionLog({ homeDir: home, cwd });
      await runAgentTurn({
        provider: stub,
        messages: [{ role: 'user', content: '请回显' }],
        tools: registry,
        session: log,
        options: { maxTurns: 5 },
      });

      const store = new SessionStore({ homeDir: home });
      const resumed = await resumeSession(
        store,
        projectHash(cwd),
        log.sessionId,
      );
      expect(resumed).not.toBeNull();
      if (resumed === null) throw new Error('resume 不应为 null');

      expect(resumed.sessionId).toBe(log.sessionId);
      expect(resumed.entryCount).toBe(9);
      expect(resumed.firstTs).toBeGreaterThan(0);
      expect(resumed.lastTs).toBeGreaterThanOrEqual(resumed.firstTs);
      expect(resumed.messages).toEqual([
        { role: 'user', content: '请回显' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'echo',
              input: { text: '你好' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'echo',
              output: { type: 'text', value: 'echo:你好' },
            },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: '已收到。' }] },
      ]);
      expect(resumed.usage).toEqual({ inputTokens: 20, outputTokens: 8 });

      // 不存在的会话 → null
      expect(
        await resumeSession(store, projectHash(cwd), 'no-such-session'),
      ).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('usage 累计：cache 分项与缺字段合并', () => {
    const records = [
      {
        seq: 1,
        ts: 1,
        kind: 'usage' as const,
        data: {
          inputTokens: 5,
          outputTokens: 2,
          cacheReadTokens: 3,
        },
      },
      {
        seq: 2,
        ts: 2,
        kind: 'usage' as const,
        data: {
          inputTokens: 7,
          cacheReadTokens: 1,
          cacheWriteTokens: 4,
        },
      },
    ];
    expect(accumulateUsage(records)).toEqual({
      inputTokens: 12,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 4,
    });
    expect(accumulateUsage([])).toEqual({});
  });

  test('readFiles 重建：read 过的文件 resume 后 edit 不被防盲写拒绝', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      mkdirSync(cwd, { recursive: true });
      const file = join(cwd, 'a.txt');
      writeFileSync(file, 'hello world\n', 'utf8');

      const registry = new ToolRegistry().register(readTool).register(editTool);
      // 第一段：read a.txt → edit a.txt → 文本收尾（read 后 edit 放行）
      const stub1 = new StubProvider([
        toolUseEvents('read', 'call-r', { path: 'a.txt' }),
        toolUseEvents('edit', 'call-e', {
          path: 'a.txt',
          old_string: 'hello',
          new_string: 'hi',
        }),
        textEvents('完成。'),
      ]);
      const log1 = new SessionLog({ homeDir: home, cwd });
      const result1 = await runAgentTurn({
        provider: stub1,
        messages: [{ role: 'user', content: '读取并修改 a.txt' }],
        tools: registry,
        session: log1,
        cwd,
        options: { maxTurns: 5 },
      });
      expect(result1.termination).toBe('end_turn');

      // 原始会话里 edit 成功（同轮 read 已入会话级已读集合）
      const store = new SessionStore({ homeDir: home });
      const read1 = await store.read(projectHash(cwd), log1.sessionId);
      expect(read1).not.toBeNull();
      if (read1 === null) throw new Error('read1 不应为 null');
      const editResult1 = findToolResult(read1.records, 'call-e');
      expect(editResult1).toBeDefined();
      expect(editResult1?.data.ok).toBe(true);

      // resume：readFiles 重建，包含 read 过的文件（realpath 归一）
      const resumed = await resumeSession(
        store,
        projectHash(cwd),
        log1.sessionId,
        {
          cwd,
        },
      );
      expect(resumed).not.toBeNull();
      if (resumed === null) throw new Error('resume 不应为 null');
      const real = await realpath(file);
      expect(resumed.readFiles.has(real)).toBe(true);

      // 续写：直接 edit（不再 read），不应被「未读过」拒绝
      const stub2 = new StubProvider([
        toolUseEvents('edit', 'call-e2', {
          path: 'a.txt',
          old_string: 'hi',
          new_string: 'yo',
        }),
        textEvents('再改一次。'),
      ]);
      const log2 = new SessionLog({
        homeDir: home,
        cwd,
        sessionId: log1.sessionId,
      });
      const result2 = await runAgentTurn({
        provider: stub2,
        messages: [...resumed.messages, { role: 'user', content: '再改一次' }],
        tools: registry,
        session: log2,
        cwd,
        readFiles: resumed.readFiles,
        loggedUserCount: countUserMessages(resumed.messages),
        options: { maxTurns: 5 },
      });
      expect(result2.termination).toBe('end_turn');

      const read2 = await store.read(projectHash(cwd), log2.sessionId);
      expect(read2).not.toBeNull();
      if (read2 === null) throw new Error('read2 不应为 null');
      const editResult2 = findToolResult(read2.records, 'call-e2');
      expect(editResult2).toBeDefined();
      expect(editResult2?.data.ok).toBe(true);
      // 文件内容确实被第二次 edit 修改（防盲写放行后的真实副作用）
      expect(readFileSync(file, 'utf8')).toBe('yo world\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('退出后再次 resume 续写：同一会话文件继续追加，历史不重复落盘', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      mkdirSync(cwd, { recursive: true });
      const registry = new ToolRegistry().register(echoTool);
      const store = new SessionStore({ homeDir: home });

      // 第一段：记录一轮纯文本对话
      const stub1 = new StubProvider([textEvents('第一轮回复。')]);
      const log1 = new SessionLog({ homeDir: home, cwd });
      await runAgentTurn({
        provider: stub1,
        messages: [{ role: 'user', content: '你好' }],
        tools: registry,
        session: log1,
        options: { maxTurns: 5 },
      });

      // 模拟退出重启：resume 重建状态
      const resumed1 = await resumeSession(
        store,
        projectHash(cwd),
        log1.sessionId,
      );
      expect(resumed1).not.toBeNull();
      if (resumed1 === null) throw new Error('第一次 resume 不应为 null');
      expect(countUserMessages(resumed1.messages)).toBe(1);

      // 续写：同一 sessionId 续开 SessionLog（seq 延续），只追加新增段
      const log2 = new SessionLog({
        homeDir: home,
        cwd,
        sessionId: log1.sessionId,
      });
      expect(log2.seq).toBe(5); // 第一段已写 5 条（user/turn_start/usage/assistant/turn_end）
      const stub2 = new StubProvider([textEvents('第二轮回复。')]);
      const result2 = await runAgentTurn({
        provider: stub2,
        messages: [...resumed1.messages, { role: 'user', content: '继续' }],
        tools: registry,
        session: log2,
        loggedUserCount: countUserMessages(resumed1.messages),
        options: { maxTurns: 5 },
      });
      expect(result2.termination).toBe('end_turn');

      // 日志无重复：user 恰好两条，assistant 恰好两条，seq 延续
      const read = await store.read(projectHash(cwd), log1.sessionId);
      expect(read).not.toBeNull();
      if (read === null) throw new Error('read 不应为 null');
      const users = read.records.filter((r) => r.kind === 'user');
      expect(users.map((r) => r.data.text)).toEqual(['你好', '继续']);
      const assistants = read.records.filter((r) => r.kind === 'assistant');
      expect(assistants.map((r) => r.data.text)).toEqual([
        '第一轮回复。',
        '第二轮回复。',
      ]);
      expect(read.records.map((r) => r.seq)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);

      // 再次 resume：完整两轮
      const resumed2 = await resumeSession(
        store,
        projectHash(cwd),
        log1.sessionId,
      );
      expect(resumed2).not.toBeNull();
      if (resumed2 === null) throw new Error('第二次 resume 不应为 null');
      expect(resumed2.entryCount).toBe(10);
      expect(resumed2.messages).toEqual([
        { role: 'user', content: '你好' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '第一轮回复。' }],
        },
        { role: 'user', content: '继续' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '第二轮回复。' }],
        },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// listSessionsForResume：列会话（时间倒序 + 简要开头）
// ---------------------------------------------------------------------------

describe('listSessionsForResume（T-061 列会话）', () => {
  test('时间倒序、preview 取首条 user 消息并截断、projectHash 缺省列出全部项目', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      mkdirSync(cwd, { recursive: true });
      const store = new SessionStore({ homeDir: home });

      let tick = 1000;
      const log1 = new SessionLog({
        homeDir: home,
        cwd,
        now: () => tick++ * 1000,
      });
      await log1.appendUser('第一个会话的开头消息');
      await log1.appendAssistant({ text: '回复一' });
      const log2 = new SessionLog({
        homeDir: home,
        cwd,
        now: () => tick++ * 1000,
      });
      await log2.appendUser('第二个会话');

      const project = projectHash(cwd);
      const candidates = await listSessionsForResume(store, project);
      expect(candidates.map((c) => c.sessionId)).toEqual([
        log2.sessionId,
        log1.sessionId,
      ]);
      expect(candidates[0].preview).toBe('第二个会话');
      expect(candidates[1].preview).toBe('第一个会话的开头消息');
      expect(candidates[1].entryCount).toBe(2);
      expect(candidates[1].firstTs).toBeGreaterThan(0);
      expect(candidates[1].lastTs).toBeGreaterThanOrEqual(
        candidates[1].firstTs,
      );
      expect(candidates[1].maxSeq).toBe(2);
      expect(candidates[1].path.endsWith(`${log1.sessionId}.jsonl`)).toBe(true);

      // projectHash 缺省：列出所有项目下的会话（这里只有一个项目）
      const all = await listSessionsForResume(store);
      expect(all.map((c) => c.sessionId)).toEqual([
        log2.sessionId,
        log1.sessionId,
      ]);

      // 无会话项目 → 空数组
      expect(await listSessionsForResume(store, 'a'.repeat(16))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('preview 超长截断到 RESUME_PREVIEW_MAX_CHARS', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      mkdirSync(cwd, { recursive: true });
      const log = new SessionLog({ homeDir: home, cwd });
      const longText = '很长的消息'.repeat(20);
      await log.appendUser(longText);

      const store = new SessionStore({ homeDir: home });
      const candidates = await listSessionsForResume(store, projectHash(cwd));
      expect(candidates).toHaveLength(1);
      expect(candidates[0].preview.endsWith('…')).toBe(true);
      expect(candidates[0].preview.length).toBeLessThanOrEqual(
        '很长的消息'.repeat(20).length,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// rebuildReadFiles：独立工具
// ---------------------------------------------------------------------------

describe('rebuildReadFiles（T-061 readFiles 重建）', () => {
  test('只收集 read 且 ok 的条目；失败/非 read 不入集；相对路径按 cwd 解析', async () => {
    const home = tempHome();
    try {
      const cwd = join(home, 'proj');
      mkdirSync(cwd, { recursive: true });
      const file = join(cwd, 'ok.txt');
      writeFileSync(file, 'x', 'utf8');

      // 手工构造记录：read ok / read 失败 / echo 成功 / read 相对路径
      const records = [
        {
          seq: 1,
          ts: 1,
          kind: 'assistant' as const,
          data: {
            text: '',
            calls: [
              { id: 'r1', name: 'read', input: { path: 'ok.txt' } },
              { id: 'r2', name: 'read', input: { path: 'missing.txt' } },
              { id: 'e1', name: 'echo', input: { text: 'x' } },
              { id: 'r3', name: 'read', input: { path: join(cwd, 'ok.txt') } },
            ],
          },
        },
        {
          seq: 2,
          ts: 2,
          kind: 'tool_result' as const,
          data: { callId: 'r1', ok: true, forModel: 'ok' },
        },
        {
          seq: 3,
          ts: 3,
          kind: 'tool_result' as const,
          data: { callId: 'r2', ok: false, forModel: 'ENOENT' },
        },
        {
          seq: 4,
          ts: 4,
          kind: 'tool_result' as const,
          data: { callId: 'e1', ok: true, forModel: 'echo:x' },
        },
        {
          seq: 5,
          ts: 5,
          kind: 'tool_result' as const,
          data: { callId: 'r3', ok: true, forModel: 'ok' },
        },
      ];

      const set = await rebuildReadFiles(records, cwd);
      const real = await realpath(file);
      expect([...set]).toEqual([real]);
      expect(set.size).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
