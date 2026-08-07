/**
 * 增量压缩（T-070 /compact）离线测试。
 *
 * 覆盖（design 002 §7.2 增量压缩的验收面）：
 * - merge 语义：goal / filesTouched 硬事实白名单（永不改写、只追加）、
 *   条目合并 / 去重 / 追加 / 删除、纯函数（不修改入参）、rev 递增；
 * - 投影：早期轮次被摘要块替换、近 N 轮原文保留、日志原文仍在（原始线程
 *   不被修改）、折叠按轮切分（tool 结果不与 assistant tool-call 分离）、
 *   阈值门控；
 * - 触发：isCompactionNeeded 超阈值判定；
 * - runCompaction：生成 delta → merge → 新 rev + 协议 compaction 事件
 *   （压缩前后 token、折叠轮次范围）；
 * - 增量 vs 全量：多次压缩 rev 递增、领域细节不逐轮流失（对比全量重写对照组）；
 * - resume 重建：rebuildSummaryState 从会话日志 compaction 条目恢复状态；
 * - runAgentTurn 接入：超阈值触发压缩、请求收到投影、compaction 事件、
 *   TurnResult.summaryState 演进、压缩状态记入会话日志。
 *
 * 全部离线：不访问网络、不依赖真实模型——摘要生成函数一律注入 stub。
 */
import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProviderCapabilities } from '../provider/capabilities';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
  StreamFinishReason,
} from '../provider/types';
import type { CompactionData } from '../protocol/events';
import { SessionLog, type SessionRecord } from '../session/log';
import { runAgentTurn, type RuntimeEvent } from '../runtime/loop';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import {
  buildSummaryBlock,
  compactProjection,
  DEFAULT_KEEP_TURNS,
  isCompactionNeeded,
  runCompaction,
  serializeSummary,
  splitThreadIntoTurns,
} from './compact';
import type {
  CompactOptions,
  SummaryDelta,
  SummaryDeltaGenerator,
} from './compact';
import {
  createSummaryState,
  isEmptySummary,
  isSummaryState,
  itemKey,
  merge,
  rebuildSummaryState,
} from './summary';
import type { SummaryState } from './summary';
import { serializeMessageText } from './project';

// ---------------------------------------------------------------------------
// 测试替身：StubProvider（不访问外网）+ 消息/事件构造助手
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
  /** 每次 streamChat 收到的消息序列（验证「请求收到的是投影」用）。 */
  readonly seenMessages: ModelMessage[][] = [];
  private calls = 0;

  constructor(private readonly rounds: ReadonlyArray<readonly StreamEvent[]>) {}

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    this.seenMessages.push(input.messages);
    const round = this.rounds[Math.min(this.calls, this.rounds.length - 1)];
    this.calls += 1;
    for (const event of round) yield event;
  }
}

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const assistant = (text: string): ModelMessage => ({
  role: 'assistant',
  content: text,
});
const textEvent = (delta: string): StreamEvent => ({
  type: 'text_delta',
  delta,
});
const usageEvent = (input: number, output: number): StreamEvent => ({
  type: 'usage',
  usage: { inputTokens: input, outputTokens: output },
});
const finishEvent = (reason: StreamFinishReason = 'stop'): StreamEvent => ({
  type: 'finish',
  reason,
});

/** 提取消息序列的全部文本（断言「投影替换 / 保留」用）。 */
function texts(messages: readonly ModelMessage[]): string[] {
  return messages.map((message) => serializeMessageText(message));
}

/** 一条含「目标 + 待办 + 触及文件」的非空摘要状态（投影折叠的素材）。 */
function summaryState(): SummaryState {
  return merge(createSummaryState(), {
    goal: '修复构建',
    todo: [{ id: 't1', text: '检查 CI' }],
    filesTouched: [{ path: 'src/x.ts', note: '已修改' }],
  });
}

/** 四条轮次的典型线程（早期 + 中期 + 近期 + 当前输入）。 */
function longThread(): ModelMessage[] {
  return [
    user('任务开始'),
    assistant('好的，开始执行。'),
    user('读 config'),
    assistant('读到了配置。'),
    user('修改文件'),
    assistant('文件已修改。'),
    user('当前输入'),
  ];
}

// ---------------------------------------------------------------------------
// merge：增量合并语义（002 7.2）
// ---------------------------------------------------------------------------

describe('merge（002 7.2 增量合并，非全量重写）', () => {
  test('goal 永不改写：既有非空时忽略 delta.goal；既有为空时接收', () => {
    const existing = { ...createSummaryState(), rev: 2, goal: '原始任务' };
    const merged = merge(existing, { goal: '被改写的目标' });
    expect(merged.goal).toBe('原始任务');
    expect(merged.rev).toBe(3);

    const fresh = merge(createSummaryState(), { goal: '初始需求' });
    expect(fresh.goal).toBe('初始需求');
  });

  test('filesTouched 硬事实：只追加、按 path 去重、同 path 保留既有', () => {
    const existing = merge(createSummaryState(), {
      filesTouched: [{ path: '/a.ts', note: '读' }],
    });
    const merged = merge(existing, {
      filesTouched: [
        { path: '/a.ts', note: '改' }, // 同 path：保留既有（永不改写）
        { path: '/b.ts', note: '新增' },
      ],
    });
    expect(merged.filesTouched.map((file) => file.path)).toEqual([
      '/a.ts',
      '/b.ts',
    ]);
    expect(merged.filesTouched[0].note).toBe('读');
  });

  test('条目合并/去重/追加：同 id 更新、同文本去重、新文本追加', () => {
    const existing = merge(createSummaryState(), {
      todo: [{ id: 't1', text: '写测试' }, { text: '通用文本' }],
    });
    const merged = merge(existing, {
      todo: [
        { id: 't1', text: '写测试（更新版）' }, // 同 id → 替换（「改」）
        { text: '通用文本' }, // 同文本 → 去重
        { id: 't2', text: '新的待办' }, // 新键 → 追加（「增」）
      ],
    });
    expect(merged.todo).toHaveLength(3);
    expect(merged.todo[0]).toEqual({ id: 't1', text: '写测试（更新版）' });
    expect(merged.todo[1]).toEqual({ text: '通用文本' });
    expect(merged.todo[2]).toEqual({ id: 't2', text: '新的待办' });
  });

  test('removed：显式删除条目；filesTouched 不可删（硬事实白名单）', () => {
    const existing = merge(createSummaryState(), {
      todo: [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      filesTouched: [{ path: '/x.ts' }],
    });
    const merged = merge(existing, {
      removed: [
        { list: 'todo', key: 'a' },
        { list: 'filesTouched', key: '/x.ts' }, // 应被忽略
      ],
    });
    expect(merged.todo.map((item) => item.text)).toEqual(['B']);
    expect(merged.filesTouched).toHaveLength(1);
  });

  test('merge 是纯函数：不修改 existing / delta 的任何数组', () => {
    const existing = merge(createSummaryState(), {
      todo: [{ id: 't1', text: '写测试' }],
    });
    const existingSnapshot = JSON.stringify(existing);
    const delta: SummaryDelta = {
      todo: [{ id: 't1', text: '写测试（更新版）' }],
      filesTouched: [{ path: '/x.ts' }],
    };
    const deltaSnapshot = JSON.stringify(delta);
    merge(existing, delta);
    expect(JSON.stringify(existing)).toBe(existingSnapshot);
    expect(JSON.stringify(delta)).toBe(deltaSnapshot);
  });

  test('rev 单调递增：每次 merge +1', () => {
    let state = createSummaryState();
    expect(state.rev).toBe(0);
    state = merge(state, { goal: 'g' });
    expect(state.rev).toBe(1);
    state = merge(state, { todo: [{ text: 'x' }] });
    expect(state.rev).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 投影：早期轮次 → 摘要块，近 N 轮原文保留（002 4.1「日志原文仍在」）
// ---------------------------------------------------------------------------

describe('compactProjection（投影折叠）', () => {
  test('早期轮次被摘要块替换、近 N 轮原文与当前输入保留', () => {
    const thread = longThread();
    const projected = compactProjection(thread, summaryState(), {
      keepTurns: 2,
    });
    // 首条 = 摘要占位块（system 角色，含 goal 与 filesTouched 硬事实）
    expect(projected[0].role).toBe('system');
    const block = serializeMessageText(projected[0]);
    expect(block).toContain('修复构建');
    expect(block).toContain('src/x.ts');
    expect(block).toContain('检查 CI');
    // 保留近 2 轮原文 + 当前输入
    const kept = texts(projected.slice(1));
    expect(kept).toContain('修改文件');
    expect(kept).toContain('当前输入');
    // 更早轮次被折叠（原文不进入请求）
    expect(kept).not.toContain('任务开始');
    expect(kept).not.toContain('读 config');
  });

  test('日志原文仍在：投影不修改原始线程（只影响发给模型的请求）', () => {
    const thread = longThread();
    const snapshot = JSON.stringify(thread);
    compactProjection(thread, summaryState(), { keepTurns: 2 });
    expect(JSON.stringify(thread)).toBe(snapshot);
    expect(thread).toHaveLength(7);
  });

  test('轮数不超过 keepTurns 时不折叠（全量原文）', () => {
    const thread = longThread();
    const projected = compactProjection(thread, summaryState(), {
      keepTurns: longThread().length,
    });
    expect(projected).toHaveLength(thread.length);
  });

  test('空摘要 / 未提供摘要时不折叠', () => {
    const thread = longThread();
    expect(compactProjection(thread, undefined, { keepTurns: 2 })).toHaveLength(
      thread.length,
    );
    expect(
      compactProjection(thread, createSummaryState(), { keepTurns: 2 }),
    ).toHaveLength(thread.length);
  });

  test('thresholdTokens 门控：未超阈值不折叠', () => {
    const thread = longThread();
    const folded = compactProjection(thread, summaryState(), {
      keepTurns: 2,
      thresholdTokens: 1, // 任意非零小阈值 → 超阈值 → 折叠
    });
    expect(folded.length).toBeLessThan(thread.length);

    const notFolded = compactProjection(thread, summaryState(), {
      keepTurns: 2,
      thresholdTokens: Number.MAX_SAFE_INTEGER,
    });
    expect(notFolded).toHaveLength(thread.length);
  });

  test('折叠按轮切分：assistant 的 tool-call 与其 tool 结果不分离', () => {
    const thread: ModelMessage[] = [
      user('第一轮'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '读文件' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'read',
            input: { path: 'a.ts' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'read',
            output: { type: 'text', value: 'file content' },
          },
        ],
      },
      user('第二轮'),
      assistant('改好了'),
      user('当前输入'),
    ];
    // keepTurns=1 → 只保留最后一轮（当前输入）；前两轮（含 tool 轮）整体折叠
    const projected = compactProjection(thread, summaryState(), {
      keepTurns: 1,
    });
    const kept = projected.slice(1);
    expect(kept).toHaveLength(1);
    expect(kept[0].role).toBe('user');
    expect(serializeMessageText(kept[0])).toBe('当前输入');
    // 折叠区被摘要块整体替换：没有残留的悬空 tool-result
    expect(projected[0].role).toBe('system');
    expect(texts(projected)).not.toContain('file content');
  });

  test('splitThreadIntoTurns：从 user 消息分界', () => {
    const turns = splitThreadIntoTurns(longThread());
    expect(turns).toHaveLength(4);
    expect(turns[0]).toHaveLength(2); // user + assistant
    expect(turns[3]).toHaveLength(1); // 当前输入
  });
});

// ---------------------------------------------------------------------------
// 触发：超阈值判定
// ---------------------------------------------------------------------------

describe('isCompactionNeeded（超阈值触发）', () => {
  test('估算超阈值返回 true、未超返回 false、未配置恒 false', () => {
    const thread = [user('a'.repeat(4000))]; // 约 1000 token（4 字符/token）
    expect(isCompactionNeeded(thread, 100)).toBe(true);
    expect(isCompactionNeeded(thread, 10_000)).toBe(false);
    expect(isCompactionNeeded(thread, undefined)).toBe(false);
    expect(isCompactionNeeded(thread, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runCompaction：压缩驱动 + compaction 事件
// ---------------------------------------------------------------------------

describe('runCompaction（压缩驱动 + 协议 compaction 事件）', () => {
  const state = (): SummaryState =>
    merge(createSummaryState(), { goal: '修复构建' });

  test('生成 delta → merge 进既有状态 → 新 rev + 事件负载', async () => {
    const thread = longThread();
    const outcome = await runCompaction(thread, state(), {
      keepTurns: 2,
      generateDelta: async ({ folded }) => {
        // stub：把折叠区大小记入 findings
        expect(folded.length).toBeGreaterThan(0);
        return {
          findings: [{ id: 'f1', text: `折叠了 ${folded.length} 条消息` }],
        };
      },
    });
    expect(outcome.state.rev).toBe(2); // state() rev=1 + merge → 2
    expect(outcome.state.goal).toBe('修复构建'); // goal 未改写
    expect(outcome.state.findings).toHaveLength(1);
    // 事件负载：压缩前后 token + 折叠轮次范围（4 轮 - 保留 2 轮 = [1, 2]）
    expect(outcome.event.beforeTokens).toBeGreaterThan(0);
    expect(outcome.event.afterTokens).toBeGreaterThan(0);
    expect(outcome.event.coveredTurns).toEqual([1, 2]);
  });

  test('未注入摘要生成函数时抛出（可诊断）', async () => {
    await expect(runCompaction(longThread(), state(), {})).rejects.toThrow(
      '未注入摘要生成函数',
    );
  });

  test('buildSummaryBlock / serializeSummary：渲染摘要块文本', () => {
    const block = buildSummaryBlock(summaryState());
    expect(block.role).toBe('system');
    const text = serializeSummary(summaryState());
    expect(text).toContain('rev=1');
    expect(text).toContain('目标：修复构建');
    expect(text).toContain('触及文件：');
  });
});

// ---------------------------------------------------------------------------
// 增量 vs 全量（002 7.2：防 context collapse）
// ---------------------------------------------------------------------------

describe('增量 vs 全量（领域细节不逐轮流失）', () => {
  /** 模拟 5 轮压缩：每轮生成一个新事实。useMerge = 增量合并，否则全量重写。 */
  function simulate(useMerge: boolean): SummaryState {
    let state = createSummaryState();
    for (let round = 1; round <= 5; round += 1) {
      const delta: SummaryDelta = {
        findings: [{ id: `fact-${round}`, text: `fact-${round} 详情` }],
      };
      state = useMerge
        ? merge(state, delta)
        : merge(createSummaryState(), delta); // 全量重写对照组
    }
    return state;
  }

  test('增量合并：全部事实累积、rev 递增；全量重写只留最后一轮', () => {
    const merged = simulate(true);
    const rewritten = simulate(false);

    expect(merged.findings).toHaveLength(5);
    expect(merged.findings.map((item) => item.text)).toContain('fact-1 详情');
    expect(merged.findings.map((item) => item.text)).toContain('fact-5 详情');
    expect(merged.rev).toBe(5);

    // 对照组：全量重写逐轮丢失早期事实（context collapse 的症状）
    expect(rewritten.findings).toHaveLength(1);
    expect(rewritten.findings[0].text).toBe('fact-5 详情');
  });

  test('端到端多次 runCompaction：首轮折叠的事实在后继压缩中不流失', async () => {
    let state = merge(createSummaryState(), { goal: '长任务' });
    const generator: SummaryDeltaGenerator = async ({ folded }) => {
      const facts = [
        ...new Set(
          folded
            .map((message) => serializeMessageText(message))
            .join('\n')
            .match(/fact-\d+/g) ?? [],
        ),
      ];
      return {
        findings: facts.map((fact) => ({ id: fact, text: `${fact} 详情` })),
      };
    };
    for (let round = 1; round <= 4; round += 1) {
      const thread = [
        user('早期轮次'),
        assistant('fact-1 已被折叠'),
        user('中间轮次'),
        assistant('fact-2 已被折叠'),
        user('近期轮次'),
        assistant(`fact-${round} 最新`),
        user('当前输入'),
      ];
      const outcome = await runCompaction(thread, state, {
        keepTurns: 1,
        generateDelta: generator,
      });
      state = outcome.state;
    }
    // 初始 rev=1（merge goal）+ 4 次压缩 → rev=5
    expect(state.rev).toBe(5);
    const facts = state.findings.map((item) => item.text);
    expect(facts).toContain('fact-1 详情');
    expect(facts).toContain('fact-2 详情');
    expect(facts).toContain('fact-4 详情');
  });
});

// ---------------------------------------------------------------------------
// resume 重建：从会话日志 compaction 条目恢复状态（T-070 接入项 4）
// ---------------------------------------------------------------------------

describe('rebuildSummaryState（/resume 重建）', () => {
  test('从最后一条 compaction 条目重建状态（最新压缩史）', () => {
    const state1 = merge(createSummaryState(), { goal: '任务A' });
    const state2 = merge(state1, { todo: [{ id: 't', text: '待办' }] });
    const records: SessionRecord[] = [
      { seq: 1, ts: 1, kind: 'user', data: { text: '开始' } },
      {
        seq: 2,
        ts: 2,
        kind: 'compaction',
        data: { covers: [1, 2], summaryRev: 1, state: state1 },
      },
      { seq: 3, ts: 3, kind: 'user', data: { text: '继续' } },
      {
        seq: 4,
        ts: 4,
        kind: 'compaction',
        data: { covers: [1, 3], summaryRev: 2, state: state2 },
      },
    ];
    const rebuilt = rebuildSummaryState(records);
    expect(rebuilt).toBeDefined();
    expect(rebuilt!.rev).toBe(2);
    expect(rebuilt!.goal).toBe('任务A');
    expect(rebuilt!.todo).toHaveLength(1);
  });

  test('无 compaction 条目返回 undefined；state 非法时跳过', () => {
    expect(
      rebuildSummaryState([
        { seq: 1, ts: 1, kind: 'user', data: { text: 'hi' } },
      ]),
    ).toBeUndefined();
    expect(
      rebuildSummaryState([
        {
          seq: 1,
          ts: 1,
          kind: 'compaction',
          data: { covers: [1, 1], summaryRev: 1, state: { nope: true } },
        },
      ]),
    ).toBeUndefined();
  });

  test('isSummaryState：结构守卫识别合法状态', () => {
    expect(isSummaryState(createSummaryState())).toBe(true);
    expect(isSummaryState(null)).toBe(false);
    expect(isSummaryState({ rev: 1 })).toBe(false);
    expect(isSummaryState({ ...createSummaryState(), goal: 42 })).toBe(false);
  });

  test('isEmptySummary：空状态与非空状态区分', () => {
    expect(isEmptySummary(createSummaryState())).toBe(true);
    expect(isEmptySummary(summaryState())).toBe(false);
  });

  test('itemKey：id 优先，缺省按 text', () => {
    expect(itemKey({ id: 'x', text: 't' })).toBe('x');
    expect(itemKey({ text: 't' })).toBe('t');
  });
});

// ---------------------------------------------------------------------------
// runAgentTurn 接入（T-070 接入项 4）
// ---------------------------------------------------------------------------

describe('runAgentTurn 接入（summaryState + compact 配置）', () => {
  test('超阈值触发压缩：compaction 事件、请求收到投影、summaryState 演进', async () => {
    const thread = [
      user('任务开始'),
      assistant('fact-1 详情'),
      user('读文件'),
      assistant('fact-2 详情'),
      user('改代码'),
      assistant('fact-3 详情'),
      user('当前输入'),
    ];
    const provider = new StubProvider([
      [textEvent('完成'), usageEvent(100, 10), finishEvent('stop')],
    ]);
    const state = merge(createSummaryState(), { goal: '长任务' });
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      {
        provider,
        messages: thread,
        summaryState: state,
        compact: {
          keepTurns: 2,
          thresholdTokens: 1, // 小阈值 → 必触发
          generateDelta: async () => ({
            findings: [{ id: 'f', text: '已折叠早期轮次' }],
          }),
        },
        options: { maxTurns: 1 },
      },
      (event) => {
        events.push(event);
      },
    );

    // 压缩事件：折叠 4 轮中的前 2 轮
    const compEvent = events.find((event) => event.type === 'compaction') as
      | { readonly type: 'compaction'; readonly data: CompactionData }
      | undefined;
    expect(compEvent).toBeDefined();
    expect(compEvent!.data.coveredTurns).toEqual([1, 2]);
    expect(compEvent!.data.beforeTokens).toBeGreaterThan(0);
    expect(compEvent!.data.afterTokens).toBeGreaterThan(0);

    // 状态演进：rev +1、delta 已合并
    expect(result.summaryState).toBeDefined();
    expect(result.summaryState!.rev).toBe(state.rev + 1);
    expect(result.summaryState!.findings.map((item) => item.text)).toContain(
      '已折叠早期轮次',
    );

    // 发给模型的请求是投影后的：摘要块 + 近 2 轮原文，早期轮次被折叠
    const seen = provider.seenMessages[0];
    expect(seen[0].role).toBe('system');
    const seenText = texts(seen).join('\n');
    expect(seenText).toContain('改代码');
    expect(seenText).toContain('当前输入');
    expect(seenText).not.toContain('任务开始');
    expect(seenText).not.toContain('读文件');
  });

  test('未提供 compact 配置：不压缩、不折叠（请求 = 原始线程）', async () => {
    const thread = [user('任务开始'), assistant('回复'), user('当前输入')];
    const provider = new StubProvider([
      [textEvent('ok'), usageEvent(1, 1), finishEvent('stop')],
    ]);
    const state = merge(createSummaryState(), { goal: '任务' });
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      {
        provider,
        messages: thread,
        summaryState: state,
        options: { maxTurns: 1 },
      },
      (event) => {
        events.push(event);
      },
    );
    expect(events.some((event) => event.type === 'compaction')).toBe(false);
    expect(result.summaryState!.rev).toBe(1); // 未演进
    expect(provider.seenMessages[0]).toHaveLength(thread.length);
  });

  test('压缩后状态快照记入会话日志（compaction 条目，/resume 重建依据）', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'modou-t070-'));
    try {
      const session = new SessionLog({ homeDir, cwd: homeDir });
      const provider = new StubProvider([
        [textEvent('ok'), usageEvent(1, 1), finishEvent('stop')],
      ]);
      const thread = [
        user('任务开始'),
        assistant('fact-1'),
        user('读'),
        assistant('fact-2'),
        user('改'),
        assistant('fact-3'),
        user('当前'),
      ];
      const state = merge(createSummaryState(), { goal: '任务' });
      await runAgentTurn({
        provider,
        messages: thread,
        session,
        summaryState: state,
        compact: {
          keepTurns: 2,
          thresholdTokens: 1,
          generateDelta: async () => ({
            findings: [{ id: 'f', text: '已折叠' }],
          }),
        },
        options: { maxTurns: 1 },
      });

      const lines = readFileSync(session.path, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      const records = lines.map((line) => JSON.parse(line) as SessionRecord);
      const compactionLine = records.find(
        (record) => record.kind === 'compaction',
      );
      expect(compactionLine).toBeDefined();
      const data = compactionLine!.data as {
        summaryRev: number;
        state: { rev: number; goal: string; findings: unknown[] };
      };
      expect(data.summaryRev).toBe(2);
      expect(data.state.rev).toBe(2);

      // 从日志重建：resume 后继续增量压缩无需重放全量历史
      const rebuilt = rebuildSummaryState(records);
      expect(rebuilt?.goal).toBe('任务');
      expect(rebuilt?.findings).toHaveLength(1);
      expect(rebuilt?.rev).toBe(2);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('未提供 summaryState 但提供 compact 配置：自动新建状态并压缩（TurnResult 返回演进）', async () => {
    const thread = [
      user('任务开始'),
      assistant('回复1'),
      user('读文件'),
      assistant('回复2'),
      user('改代码'),
      assistant('回复3'),
      user('当前输入'),
    ];
    const provider = new StubProvider([
      [textEvent('ok'), usageEvent(1, 1), finishEvent('stop')],
    ]);
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      {
        provider,
        messages: thread,
        compact: {
          keepTurns: 2,
          thresholdTokens: 1,
          generateDelta: async () => ({
            goal: '任务',
            todo: [{ id: 't', text: '待办' }],
          }),
        },
        options: { maxTurns: 1 },
      },
      (event) => {
        events.push(event);
      },
    );
    expect(events.some((event) => event.type === 'compaction')).toBe(true);
    expect(result.summaryState).toBeDefined();
    expect(result.summaryState!.rev).toBe(1); // 空状态 + 一次压缩
    expect(result.summaryState!.goal).toBe('任务');
  });

  test('未注入生成函数但超阈值：跳过压缩、按既有摘要折叠投影（notice 提示）', async () => {
    const thread = [
      user('任务开始'),
      assistant('回复1'),
      user('读文件'),
      assistant('回复2'),
      user('改代码'),
      assistant('回复3'),
      user('当前输入'),
    ];
    const provider = new StubProvider([
      [textEvent('ok'), usageEvent(1, 1), finishEvent('stop')],
    ]);
    const state = summaryState();
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      {
        provider,
        messages: thread,
        summaryState: state,
        compact: { keepTurns: 2, thresholdTokens: 1 }, // 无 generateDelta
        options: { maxTurns: 1 },
      },
      (event) => {
        events.push(event);
      },
    );
    // 无 compaction 事件，但发了 notice；投影仍按既有摘要折叠
    expect(events.some((event) => event.type === 'compaction')).toBe(false);
    expect(
      events.some((event) => event.type === 'notice' && event.level === 'warn'),
    ).toBe(true);
    expect(result.summaryState!.rev).toBe(1); // 未演进
    const seen = provider.seenMessages[0];
    expect(seen[0].role).toBe('system');
    expect(texts(seen)).not.toContain('任务开始');
  });
});

// ---------------------------------------------------------------------------
// 迟滞（T-070）：压缩后 K 轮内不重复触发；compaction 事件与日志只在该触发
// ---------------------------------------------------------------------------

describe('压缩迟滞（minTurnsBetweenCompactions）', () => {
  const echoTool: Tool = {
    name: 'echo',
    description: '原样返回输入（测试用）',
    risk: 'read',
    schema: z.object({ text: z.string().min(1) }),
    execute: async (args: { text: string }) => ({
      ok: true,
      forModel: `echo:${args.text}`,
    }),
  };

  /** 构造 N 轮工具调用 + 1 轮文本收尾的 stub 轮次（多轮驱动 loop 的 tool 循环）。 */
  function toolRounds(count: number, finalText = '完成'): StreamEvent[][] {
    const rounds: StreamEvent[][] = [];
    for (let i = 1; i <= count; i += 1) {
      rounds.push([
        {
          type: 'tool_use',
          id: `c${i}`,
          name: 'echo',
          input: { text: `x${i}` },
        },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
        { type: 'finish', reason: 'tool_use' },
      ]);
    }
    rounds.push([textEvent(finalText), usageEvent(1, 1), finishEvent('stop')]);
    return rounds;
  }

  /** 超阈值且轮数超 keepTurns 的线程（4 轮）。 */
  function overThresholdThread(): ModelMessage[] {
    return [
      user('任务开始'),
      assistant('开始'),
      user('读文件'),
      assistant('读到'),
      user('改代码'),
      assistant('已改'),
      user('当前输入'),
    ];
  }

  /** 迟滞压缩配置：stub 生成函数 + 指定迟滞窗口。 */
  function compactConfig(minTurnsBetweenCompactions: number): CompactOptions {
    return {
      keepTurns: 1,
      thresholdTokens: 1,
      minTurnsBetweenCompactions,
      generateDelta: async () => ({ findings: [{ id: 'f', text: '已折叠' }] }),
    };
  }

  test('单次调用内：压缩后 K 轮内不重复触发，K 轮后再触发（minTurns=2 → 第 1、3 轮）', async () => {
    const registry = new ToolRegistry().register(echoTool);
    const provider = new StubProvider(toolRounds(3)); // 3 工具轮 + 1 文本轮
    const state = merge(createSummaryState(), { goal: '长任务' });
    const events: RuntimeEvent[] = [];
    const result = await runAgentTurn(
      {
        provider,
        messages: overThresholdThread(),
        tools: registry,
        summaryState: state,
        compact: compactConfig(2),
        options: { maxTurns: 4 },
      },
      (event) => {
        events.push(event);
      },
    );

    // 只第 1、3 轮触发（turnCount 1/3）；第 2、4 轮被迟滞拦下
    const compEvents = events.filter((event) => event.type === 'compaction');
    expect(compEvents).toHaveLength(2);
    expect(compEvents[0].data.coveredTurns).toEqual([1, 3]);
    // 状态演进：rev = 初始 1 + 2 次压缩；turnCount 到 4，lastCompactedTurn 停在 3
    expect(result.summaryState).toBeDefined();
    expect(result.summaryState!.rev).toBe(state.rev + 2);
    expect(result.summaryState!.turnCount).toBe(4);
    expect(result.summaryState!.lastCompactedTurn).toBe(3);
  });

  test('compaction 事件与日志只在该触发时产生（迟滞轮次无事件、无日志条目）', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'modou-hysteresis-'));
    try {
      const session = new SessionLog({ homeDir, cwd: homeDir });
      const registry = new ToolRegistry().register(echoTool);
      const provider = new StubProvider(toolRounds(3));
      const state = merge(createSummaryState(), { goal: '长任务' });
      const events: RuntimeEvent[] = [];
      await runAgentTurn(
        {
          provider,
          messages: overThresholdThread(),
          tools: registry,
          session,
          summaryState: state,
          compact: compactConfig(2),
          options: { maxTurns: 4 },
        },
        (event) => {
          events.push(event);
        },
      );

      expect(
        events.filter((event) => event.type === 'compaction'),
      ).toHaveLength(2);
      const lines = readFileSync(session.path, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      const records = lines.map((line) => JSON.parse(line) as SessionRecord);
      expect(
        records.filter((record) => record.kind === 'compaction'),
      ).toHaveLength(2);
      // 日志里的状态快照含迟滞记账（/resume 后不立即重复压缩）：
      // 最后一条 compaction 条目记录的是触发时的记账（turnCount=3），
      // resume 后从 3 继续接续，lastCompactedTurn=3 使下次触发 ≥ 3+2。
      const rebuilt = rebuildSummaryState(records);
      expect(rebuilt?.turnCount).toBe(3);
      expect(rebuilt?.lastCompactedTurn).toBe(3);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('迟滞跨 runAgentTurn 接续：第二次调用首轮不再重复触发（TUI 每提交一轮的形态）', async () => {
    const state = merge(createSummaryState(), { goal: '长任务' });
    const events1: RuntimeEvent[] = [];
    const result1 = await runAgentTurn(
      {
        provider: new StubProvider([
          [textEvent('第一段'), usageEvent(1, 1), finishEvent('stop')],
        ]),
        messages: overThresholdThread(),
        summaryState: state,
        compact: compactConfig(5),
        options: { maxTurns: 1 },
      },
      (event) => {
        events1.push(event);
      },
    );
    // 第一次调用：首轮触发，记账 lastCompactedTurn = 1
    expect(events1.some((event) => event.type === 'compaction')).toBe(true);
    expect(result1.summaryState!.turnCount).toBe(1);
    expect(result1.summaryState!.lastCompactedTurn).toBe(1);

    // 第二次调用：传回演进状态（turnCount 接续），距上次压缩仅 1 轮 < 5 → 不触发
    const events2: RuntimeEvent[] = [];
    const result2 = await runAgentTurn(
      {
        provider: new StubProvider([
          [textEvent('第二段'), usageEvent(1, 1), finishEvent('stop')],
        ]),
        messages: overThresholdThread(),
        summaryState: result1.summaryState,
        compact: compactConfig(5),
        options: { maxTurns: 1 },
      },
      (event) => {
        events2.push(event);
      },
    );
    expect(events2.some((event) => event.type === 'compaction')).toBe(false);
    expect(result2.summaryState!.turnCount).toBe(2);
    expect(result2.summaryState!.lastCompactedTurn).toBe(1); // 未被改写
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_KEEP_TURNS 常量
// ---------------------------------------------------------------------------

describe('默认参数', () => {
  test('DEFAULT_KEEP_TURNS = 6（002 7.1 易变区近 N 轮原文）', () => {
    expect(DEFAULT_KEEP_TURNS).toBe(6);
  });
});
