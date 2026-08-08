/**
 * 写冲突检测接入 runTui 的集成测试（0.12.1 修复 #2）。
 *
 * 覆盖：
 * - runTui 装配 onFileWrite（WriteConflictDetector）：主代理先写、子代理再写
 *   同一文件 → 检出跨 agent 冲突 → loop 发 notice(warn)（子代理信封）→
 *   applySubagent 透出到提示区（App 单元层的 notice 透出见 app.test.tsx）；
 * - 不悬挂：轮次正常走完（主 1 写 → 主 2 派发子代理 → 子 1 写（冲突）→
 *   子 2 结论 → 主 3 汇总）。
 *
 * 全部离线：provider 用脚本化 stub（不访问外网），homeDir 用临时目录隔离。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup } from 'ink-testing-library';
import { z } from 'zod';
import type {
  ModelProvider,
  ProviderCapabilities,
  StreamChatInput,
  StreamEvent,
  Tool,
} from '@modou/core';
import { createTaskTool, ProviderError, ToolRegistry } from '@modou/core';
import { runTui } from './index';

// ---------------------------------------------------------------------------
// 测试替身：脚本化 StubProvider（按调用序回放预先写好的轮次，不访问外网）
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

class ScriptedProvider implements ModelProvider {
  readonly id = 'openai-compat';
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

let callId = 0;

/** 一轮只发一个 tool_use 的轮次（+ usage + finish reason tool_use）。 */
function toolUseRound(name: string, input: unknown): StreamEvent[] {
  callId += 1;
  return [
    { type: 'tool_use', id: `call-${callId}`, name, input },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: 'tool_use' },
  ];
}

/** 一轮纯文本的轮次（+ usage + finish reason stop）。 */
function textRound(text: string): StreamEvent[] {
  const events: StreamEvent[] = Array.from(text).map((char) => ({
    type: 'text_delta',
    delta: char,
  }));
  events.push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } });
  events.push({ type: 'finish', reason: 'stop' });
  return events;
}

/** 假写工具：不触碰文件系统，只自报 onFileWrite（写冲突检测的数据源）。 */
const fakeWriteTool: Tool = {
  name: 'fakewrite',
  description: '假写工具（测试用，自报 onFileWrite）',
  risk: 'read',
  schema: z.object({ path: z.string() }),
  execute: async (
    args: { path: string },
    ctx: { onFileWrite?: (path: string) => void },
  ) => {
    ctx.onFileWrite?.(args.path);
    return { ok: true, forModel: `已写入 ${args.path}` };
  },
};

// ---------------------------------------------------------------------------
// 假流（复刻 slash.test.tsx 的 FakeStdout / FakeStdin：EventEmitter 而非 Stream，
// 使 Ink 走「传入的 stdin」路径；write 即一次 input 事件）
// ---------------------------------------------------------------------------

class FakeStdout extends EventEmitter {
  get columns(): number {
    return 100;
  }

  get rows(): number {
    return 50;
  }

  readonly frames: string[] = [];
  private last?: string;

  write = (frame: string): void => {
    this.frames.push(frame);
    this.last = frame;
  };

  lastFrame = (): string => this.last ?? '';
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;

  write = (data: string): void => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}

  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

/** 等 React / Ink 渲染落地（事件流消费是异步的，多 flush 一次到位）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setTimeout(resolve, 40));
}

// ---------------------------------------------------------------------------
// 用例：runTui 写冲突检测接线
// ---------------------------------------------------------------------------

describe('runTui 写冲突检测（T-123 接线，0.12.1 修复）', () => {
  afterAll(() => {
    cleanup();
  });

  test('主代理先写、子代理再写同一文件 → 冲突 notice 透出到提示区', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const signalEmitter = new EventEmitter();
    const homeDir = mkdtempSync(join(tmpdir(), 'modou-tui-write-conflict-'));
    // 工具集：fakewrite（自报写入）+ task（派发只读子代理；子代理白名单里
    // 显式放行 fakewrite——否则子代理默认只读，写不进来）。
    const tools = new ToolRegistry()
      .register(fakeWriteTool)
      .register(createTaskTool());
    const provider = new ScriptedProvider([
      toolUseRound('fakewrite', { path: '/tmp/shared.txt' }), // 主 1：主代理写入
      toolUseRound('task', {
        prompt: '写共享文件',
        tools: ['fakewrite'],
      }), // 主 2：派发子代理
      toolUseRound('fakewrite', { path: '/tmp/shared.txt' }), // 子 1：冲突写入
      textRound('子代理结论：已写入共享文件。'), // 子 2
      textRound('已汇总子代理结论。'), // 主 3
    ]);
    const exit = runTui({
      homeDir,
      cwd: homeDir,
      // FakeStdout/FakeStdin 只实现 Ink 用到的表面，与 NodeJS 流接口无关——
      // 结构不相容，做类型收窄即可（运行时行为等价 ink-testing-library）。
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      signalEmitter,
      provider,
      tools,
      prompt: '请执行写冲突测试任务',
    });
    await flush();

    try {
      // 轮次走完：跨 agent 写冲突经 notice(warn) 透出到提示区
      const frame = stdout.lastFrame();
      expect(frame).toContain('写冲突');
      expect(frame).toContain('/tmp/shared.txt');
      expect(frame).toContain('改动可能互相覆盖');
      // 子代理的结论经主代理 task tool_result 展示（不丢结论）
      expect(frame).toContain('已汇总子代理结论。');
    } finally {
      // 干净退出（Ctrl+C）后清理临时目录
      stdin.write('\x03');
      await flush();
      await exit;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
