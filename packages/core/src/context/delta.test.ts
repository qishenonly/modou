/**
 * 生产摘要增量生成（T-070 context/delta.ts）离线测试。
 *
 * 覆盖：
 * - parseSummaryDelta：正常 JSON / markdown 围栏 / JSON 前后夹讯 / 坏 JSON /
 *   非对象 / 坏条目过滤（只保留合法条目）；
 * - createModelDeltaGenerator：stub provider 注入覆盖「解析」——正常文本产出
 *   delta、围栏文本产出 delta、坏 JSON / 空文本 / provider 抛错 → 抛
 *   SummaryDeltaError（调用方捕获降级）；
 * - 端到端：runCompaction 接生产生成器（stub）→ merge → 新 rev + 事件负载。
 *
 * 全部离线：不访问网络，provider 一律 stub。
 */
import { describe, expect, test } from 'bun:test';
import type { ProviderCapabilities } from '../provider/capabilities';
import type {
  ModelProvider,
  StreamChatInput,
  StreamEvent,
} from '../provider/types';
import { runCompaction } from './compact';
import {
  createModelDeltaGenerator,
  parseSummaryDelta,
  SummaryDeltaError,
} from './delta';
import { createSummaryState, merge } from './summary';
import type { SummaryState } from './summary';

// ---------------------------------------------------------------------------
// 测试替身：TextStubProvider（逐字符回放预设文本）+ ThrowingStubProvider
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

/** 逐字符回放预设文本（验证文本收集与解析）。 */
class TextStubProvider implements ModelProvider {
  readonly id = 'stub';
  readonly modelId = 'stub-model';
  readonly capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES;
  /** 每次 streamChat 收到的系统提示（验证缺省提示固定）。 */
  readonly seenSystem: string[] = [];
  /** 每次 streamChat 收到的 user 消息文本（验证既有状态进了提示）。 */
  readonly seenUser: string[] = [];

  constructor(private readonly text: string) {}

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    this.seenSystem.push(input.system ?? '');
    for (const message of input.messages) {
      if (typeof message.content === 'string')
        this.seenUser.push(message.content);
    }
    for (const char of this.text) yield { type: 'text_delta', delta: char };
    yield {
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: this.text.length },
    };
    yield { type: 'finish', reason: 'stop' };
  }
}

/** 直接抛错的 provider（验证失败降级路径）。 */
class ThrowingStubProvider implements ModelProvider {
  readonly id = 'stub';
  readonly modelId = 'stub-model';
  readonly capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES;

  async *streamChat(): AsyncIterable<StreamEvent> {
    throw new Error('provider boom');
  }
}

/** 有目标 + 待办 + 触及文件的既有状态（生成提示与 merge 的素材）。 */
function seededState(): SummaryState {
  return merge(createSummaryState(), {
    goal: '修复构建',
    todo: [{ id: 't1', text: '检查 CI' }],
    filesTouched: [{ path: 'src/x.ts', note: '已修改' }],
  });
}

// ---------------------------------------------------------------------------
// parseSummaryDelta：容错 JSON 解析
// ---------------------------------------------------------------------------

describe('parseSummaryDelta（容错 JSON 解析）', () => {
  test('正常 JSON：各字段按结构解析', () => {
    const delta = parseSummaryDelta(
      JSON.stringify({
        goal: '新目标',
        todo: [{ id: 't1', text: '更新版' }, { text: '新待办' }],
        filesTouched: [{ path: 'src/a.ts', note: '读过' }],
        removed: [{ list: 'done', key: 'd1' }],
      }),
    );
    expect(delta).not.toBeNull();
    expect(delta!.goal).toBe('新目标');
    expect(delta!.todo).toEqual([
      { id: 't1', text: '更新版' },
      { text: '新待办' },
    ]);
    expect(delta!.filesTouched).toEqual([{ path: 'src/a.ts', note: '读过' }]);
    expect(delta!.removed).toEqual([{ list: 'done', key: 'd1' }]);
  });

  test('markdown 围栏（```json …```）内嵌 JSON：剥围栏后解析', () => {
    const delta = parseSummaryDelta(
      '```json\n{"findings": [{"text": "围栏内的事实"}]}\n```',
    );
    expect(delta).not.toBeNull();
    expect(delta!.findings).toEqual([{ text: '围栏内的事实' }]);
  });

  test('JSON 前后夹解释文字：提取 {…} 子串后解析', () => {
    const delta = parseSummaryDelta(
      '好的，这是增量：\n{"decisions": [{"text": "决策X"}]}\n以上。',
    );
    expect(delta).not.toBeNull();
    expect(delta!.decisions).toEqual([{ text: '决策X' }]);
  });

  test('坏 JSON / 非对象：返回 null（调用方降级）', () => {
    expect(parseSummaryDelta('不是 JSON')).toBeNull();
    expect(parseSummaryDelta('```json\n{坏掉的\n```')).toBeNull();
    expect(parseSummaryDelta('[]')).toBeNull(); // 数组不是对象
    expect(parseSummaryDelta('42')).toBeNull();
    expect(parseSummaryDelta('')).toBeNull();
  });

  test('坏条目过滤：只保留合法条目（text/path/list 字段校验）', () => {
    const delta = parseSummaryDelta(
      JSON.stringify({
        todo: [
          { text: '合法待办' },
          { text: '' }, // 空 text → 丢弃
          { id: 42, text: '非法 id 保留 text' }, // id 非字符串 → 丢弃 id
          null,
        ],
        filesTouched: [
          { path: 'src/ok.ts' },
          { path: '' }, // 空 path → 丢弃
          { note: '无 path' }, // 缺 path → 丢弃
        ],
        removed: [
          { list: 'todo', key: 'k1' },
          { list: 'filesTouched', key: '/x' }, // 非法 list → 丢弃（白名单由 merge 守卫）
          { list: 'nope', key: 'k' },
        ],
      }),
    );
    expect(delta).not.toBeNull();
    expect(delta!.todo).toEqual([
      { text: '合法待办' },
      { text: '非法 id 保留 text' },
    ]);
    expect(delta!.filesTouched).toEqual([{ path: 'src/ok.ts' }]);
    expect(delta!.removed).toEqual([{ list: 'todo', key: 'k1' }]);
  });

  test('goal 空串忽略；无有效字段返回空增量（非 null）', () => {
    const delta = parseSummaryDelta('{"goal": "", "todo": []}');
    expect(delta).not.toBeNull();
    expect(delta!.goal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createModelDeltaGenerator：模型提示 → 文本收集 → 解析（stub provider）
// ---------------------------------------------------------------------------

describe('createModelDeltaGenerator（stub provider 覆盖解析）', () => {
  test('正常文本：产出 delta（提示词带既有状态，目标已在摘要里则不给 goal）', async () => {
    const provider = new TextStubProvider(
      JSON.stringify({
        todo: [{ id: 't1', text: '检查 CI（更新）' }],
        findings: [{ text: '折叠区新事实' }],
      }),
    );
    const generator = createModelDeltaGenerator(provider);
    const delta = await generator({ folded: [], state: seededState() });

    expect(delta.todo).toEqual([{ id: 't1', text: '检查 CI（更新）' }]);
    expect(delta.findings).toEqual([{ text: '折叠区新事实' }]);
    expect(delta.goal).toBeUndefined(); // 既有目标非空，模型不给 goal
    // user 提示带着既有摘要状态（serializeSummary 含目标与触及文件）
    const userText = provider.seenUser[0] ?? '';
    expect(userText).toContain('修复构建');
    expect(userText).toContain('src/x.ts');
  });

  test('围栏文本：剥围栏后解析（生产降级路径覆盖）', async () => {
    const provider = new TextStubProvider(
      '```json\n{"constraints": [{"text": "不引入重型依赖"}]}\n```',
    );
    const delta = await createModelDeltaGenerator(provider)({
      folded: [],
      state: seededState(),
    });
    expect(delta.constraints).toEqual([{ text: '不引入重型依赖' }]);
  });

  test('坏 JSON：抛 SummaryDeltaError（loop 捕获发 notice 降级）', async () => {
    const provider = new TextStubProvider('抱歉，我没法生成 JSON。');
    const generator = createModelDeltaGenerator(provider);
    await expect(
      generator({ folded: [], state: seededState() }),
    ).rejects.toThrow(SummaryDeltaError);
  });

  test('空文本：抛 SummaryDeltaError', async () => {
    const provider = new TextStubProvider('');
    const generator = createModelDeltaGenerator(provider);
    await expect(
      generator({ folded: [], state: seededState() }),
    ).rejects.toThrow('空文本');
  });

  test('provider 抛错：包装为 SummaryDeltaError（保留 cause）', async () => {
    const generator = createModelDeltaGenerator(new ThrowingStubProvider());
    await expect(
      generator({ folded: [], state: seededState() }),
    ).rejects.toThrow(SummaryDeltaError);
    await generator({ folded: [], state: seededState() }).catch((caught) => {
      expect((caught as SummaryDeltaError).cause).toBeInstanceOf(Error);
    });
  });
});

// ---------------------------------------------------------------------------
// 端到端：runCompaction 接生产生成器（stub）
// ---------------------------------------------------------------------------

describe('runCompaction + createModelDeltaGenerator（端到端，stub）', () => {
  test('生成 delta → merge 进既有状态 → 新 rev + 事件负载', async () => {
    const provider = new TextStubProvider(
      JSON.stringify({
        findings: [{ id: 'f1', text: '折叠区新事实' }],
      }),
    );
    const state = seededState();
    const outcome = await runCompaction(
      [
        { role: 'user', content: '早期任务' },
        { role: 'assistant', content: '已处理' },
        { role: 'user', content: '当前输入' },
      ],
      state,
      { keepTurns: 1, generateDelta: createModelDeltaGenerator(provider) },
    );

    // 既有事实保留（增量合并非全量重写）+ 新事实并入
    expect(outcome.state.rev).toBe(state.rev + 1);
    expect(outcome.state.goal).toBe('修复构建');
    expect(outcome.state.todo).toEqual([{ id: 't1', text: '检查 CI' }]);
    expect(outcome.state.findings).toEqual([
      { id: 'f1', text: '折叠区新事实' },
    ]);
    expect(outcome.event.coveredTurns).toEqual([1, 1]);
    expect(outcome.event.beforeTokens).toBeGreaterThan(0);
    expect(outcome.event.afterTokens).toBeGreaterThan(0);
  });
});
