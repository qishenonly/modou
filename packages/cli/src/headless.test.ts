import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultWriteTools, ProviderError } from '@modou/core';
import type {
  ModelProvider,
  ProviderCapabilities,
  StreamChatInput,
  StreamEvent,
} from '@modou/core';
import { runHeadless } from './headless';

// ---------------------------------------------------------------------------
// 测试替身：本地假 Provider（端到端 headless 输出，不访问外网）
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  maxContext: 128_000,
  parallelToolCalls: false,
  cacheBreakpoints: false,
  images: false,
  thinking: 'none',
  strictJsonArgs: true,
};

type StubRound = StreamEvent[] | { readonly throw: unknown };

class StubProvider implements ModelProvider {
  readonly id = 'stub';
  readonly modelId = 'stub-model';
  readonly capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES;
  private callCount = 0;

  constructor(private readonly rounds: StubRound[]) {}

  /** 最近一次请求收到的 system（集成测试断言 headless 注入了什么）。 */
  lastSystem: string | undefined;

  async *streamChat(input: StreamChatInput): AsyncIterable<StreamEvent> {
    this.lastSystem = input.system;
    const round = this.rounds[Math.min(this.callCount, this.rounds.length - 1)];
    this.callCount += 1;
    if ('throw' in round) throw round.throw;
    for (const event of round) yield event;
  }
}

describe('runHeadless（`modou -p` 的 headless 输出）', () => {
  test('text_delta 流式写入 stdout，usage 摘要与终止信息写入 stderr', async () => {
    const stub = new StubProvider([
      [
        { type: 'text_delta', delta: '你' },
        { type: 'text_delta', delta: '好' },
        { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
        { type: 'finish', reason: 'stop' },
      ],
    ]);

    let stdout = '';
    let stderr = '';
    const { result, envelopes } = await runHeadless({
      provider: stub,
      prompt: '你好',
      write: (chunk) => {
        stdout += chunk;
      },
      writeError: (chunk) => {
        stderr += chunk;
      },
    });

    // stdout 是纯回答文本
    expect(stdout).toBe('你好');
    expect(stderr).toContain('输入 7 token');
    expect(stderr).toContain('输出 3 token');

    expect(result.termination).toBe('end_turn');
    expect(result.text).toBe('你好');

    // 协议信封完整产出（turn_start 开路，turn_end 收尾）
    expect(envelopes[0].type).toBe('turn_start');
    expect(envelopes[envelopes.length - 1].type).toBe('turn_end');
    expect(envelopes.some((e) => e.type === 'usage')).toBe(true);
  });

  test('stdout 保持纯回答：usage 摘要不混入（写入 out.txt 是干净答案）', async () => {
    const stub = new StubProvider([
      [
        { type: 'text_delta', delta: '答案是 42' },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
        { type: 'finish', reason: 'stop' },
      ],
    ]);

    let stdout = '';
    let stderr = '';
    await runHeadless({
      provider: stub,
      prompt: 'hi',
      write: (chunk) => {
        stdout += chunk;
      },
      writeError: (chunk) => {
        stderr += chunk;
      },
    });

    expect(stdout).toBe('答案是 42');
    expect(stdout).not.toContain('token');
    expect(stderr).toContain('token');
  });

  test('provider 抛非重试错误：stderr 含分类与建议，termination = error', async () => {
    const stub = new StubProvider([
      {
        throw: new ProviderError({
          kind: 'invalid_api_key',
          message: 'API Key 无效或缺失（401）',
        }),
      },
    ]);

    let stdout = '';
    let stderr = '';
    const { result } = await runHeadless({
      provider: stub,
      prompt: 'hi',
      write: (chunk) => {
        stdout += chunk;
      },
      writeError: (chunk) => {
        stderr += chunk;
      },
    });

    expect(result.termination).toBe('error');
    expect(stdout).toBe('');
    // 错误信息可诊断：分类 + 不可重试 + 建议
    expect(stderr).toContain('invalid_api_key');
    expect(stderr).toContain('不可重试');
    expect(stderr).toContain('检查 API Key 配置');
  });

  test('可重试错误重试耗尽：stderr 带「重试 N 次仍失败」说明（0 延迟注入）', async () => {
    const stub = new StubProvider([
      {
        throw: new ProviderError({ kind: 'server_error', message: '上游 500' }),
      },
    ]);

    let stderr = '';
    const { result } = await runHeadless({
      provider: stub,
      prompt: 'hi',
      retry: { maxAttempts: 3, sleep: async () => {}, random: () => 0 },
      write: () => {},
      writeError: (chunk) => {
        stderr += chunk;
      },
    });

    expect(result.termination).toBe('error');
    expect(stderr).toContain('server_error');
    expect(stderr).toContain('可重试');
    expect(stderr).toContain('重试 2 次仍失败');
    expect(stderr).toContain('上游 500');
  });

  test('内部错误（非 ProviderError 未知异常）：stderr 标记内部错误，不回喂模型', async () => {
    const stub = new StubProvider([{ throw: new Error('适配器 bug') }]);

    let stderr = '';
    const { result } = await runHeadless({
      provider: stub,
      prompt: 'hi',
      write: () => {},
      writeError: (chunk) => {
        stderr += chunk;
      },
    });

    expect(result.termination).toBe('error');
    expect(result.error?.category).toBe('internal');
    expect(stderr).toContain('内部错误');
    expect(stderr).toContain('适配器 bug');
  });

  test('max_turns 上限：halted 终止并在 stderr 提示', async () => {
    const stub = new StubProvider([
      [
        { type: 'tool_use', id: 'c1', name: 'bash', input: { cmd: 'ls' } },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish', reason: 'tool_use' },
      ],
    ]);

    let stderr = '';
    const { result } = await runHeadless({
      provider: stub,
      prompt: 'hi',
      maxTurns: 1,
      write: () => {},
      writeError: (chunk) => {
        stderr += chunk;
      },
    });

    expect(result.termination).toBe('halted');
    expect(stderr).toContain('达到轮次/预算上限');
  });

  test('缺省注入系统提示词：发给模型的 system 含搜索优先策略与全部工具', async () => {
    const stub = new StubProvider([
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'finish', reason: 'stop' },
      ],
    ]);

    await runHeadless({
      provider: stub,
      prompt: 'hi',
      write: () => {},
      writeError: () => {},
    });

    expect(stub.lastSystem).toBeDefined();
    expect(stub.lastSystem).toContain('搜索优先策略');
    expect(stub.lastSystem).toContain('先 Glob/Grep 定位');
    // 默认只读工具集（read / grep / glob）全部声明给模型
    expect(stub.lastSystem).toContain('### read');
    expect(stub.lastSystem).toContain('### grep');
    expect(stub.lastSystem).toContain('### glob');
  });

  test('自定义 system 可注入：headless 不覆盖调用方提供的 system', async () => {
    const stub = new StubProvider([
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'finish', reason: 'stop' },
      ],
    ]);
    const custom = '自定义系统指令（测试注入）';

    await runHeadless({
      provider: stub,
      prompt: 'hi',
      system: custom,
      write: () => {},
      writeError: () => {},
    });

    expect(stub.lastSystem).toBe(custom);
  });

  test('缺省只读工具集执行：read 工具结果以 tool_result 信封产出，第二轮正常收尾', async () => {
    // 真实 read 工具跑在临时 fixture 文件上：验证 headless 把 defaultReadonlyTools()
    // 传给了 runAgentTurn，管线执行结果回喂并映射为协议 tool_result。
    const dir = mkdtempSync(join(tmpdir(), 'modou-headless-'));
    const filePath = join(dir, 'answer.txt');
    writeFileSync(filePath, '答案是 42\n', 'utf8');
    try {
      const stub = new StubProvider([
        [
          {
            type: 'tool_use',
            id: 'c1',
            name: 'read',
            input: { path: filePath },
          },
          { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        [
          { type: 'text_delta', delta: '读取完成' },
          { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
          { type: 'finish', reason: 'stop' },
        ],
      ]);

      let stdout = '';
      const { envelopes, result } = await runHeadless({
        provider: stub,
        prompt: '读文件',
        write: (chunk) => {
          stdout += chunk;
        },
        writeError: () => {},
      });

      expect(result.termination).toBe('end_turn');
      expect(result.turns).toBe(2);
      expect(stdout).toBe('读取完成');

      const toolResult = envelopes.find((e) => e.type === 'tool_result');
      expect(toolResult).toBeDefined();
      if (toolResult?.type === 'tool_result') {
        expect(toolResult.data.id).toBe('c1');
        expect(toolResult.data.ok).toBe(true);
        expect(toolResult.data.summary).toContain('Read');
      }
      // 已注册工具不产生未知工具 notice
      expect(envelopes.some((e) => e.type === 'notice')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('read → edit 跨轮次放行：headless 把 readFiles/cwd 传入，edit 成功执行', async () => {
    // 防盲写的运行时链路端到端：read 工具成功读到的文件经 loop 维护的
    // 已读集合放行后续 edit。headless 只负责把 readFiles（跨轮次）与 cwd
    // 透传给 runAgentTurnStreaming。
    const dir = mkdtempSync(join(tmpdir(), 'modou-headless-edit-'));
    const filePath = join(dir, 'target.ts');
    writeFileSync(filePath, 'const value = 1;\n', 'utf8');
    try {
      const stub = new StubProvider([
        [
          {
            type: 'tool_use',
            id: 'r1',
            name: 'read',
            input: { path: filePath },
          },
          { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        [
          {
            type: 'tool_use',
            id: 'e1',
            name: 'edit',
            input: {
              path: filePath,
              old_string: 'const value = 1;',
              new_string: 'const value = 2;',
            },
          },
          { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        [
          { type: 'text_delta', delta: '完成' },
          { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
          { type: 'finish', reason: 'stop' },
        ],
      ]);

      const { result, envelopes } = await runHeadless({
        provider: stub,
        prompt: '读文件并修改',
        tools: defaultWriteTools(),
        // T-033：write/exec 工具默认要审批；本测试聚焦防盲写链路，显式放行
        autoApprove: true,
        write: () => {},
        writeError: () => {},
      });

      expect(result.termination).toBe('end_turn');
      expect(result.turns).toBe(3);
      const editResult = envelopes.find(
        (e) => e.type === 'tool_result' && e.data.id === 'e1',
      );
      expect(editResult?.type).toBe('tool_result');
      if (editResult?.type === 'tool_result') {
        expect(editResult.data.ok).toBe(true);
        expect(editResult.data.summary).toContain('Edit');
      }
      expect(readFileSync(filePath, 'utf8')).toBe('const value = 2;\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 审批策略（T-033）：默认拒绝 / autoApprove / approve 注入。
// ---------------------------------------------------------------------------

describe('headless 审批策略（T-033）', () => {
  test('默认拒绝：exec 工具调用被拦下（无人值守安全默认）', async () => {
    const stub = new StubProvider([
      [
        {
          type: 'tool_use',
          id: 'c1',
          name: 'bash',
          input: { command: 'echo hi' },
        },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish', reason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: '已停止。' },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish', reason: 'stop' },
      ],
    ]);
    const { envelopes } = await runHeadless({
      provider: stub,
      prompt: '跑一下',
      tools: defaultWriteTools(),
      write: () => {},
      writeError: () => {},
    });

    // approval_request + approval_resolved 配对；工具结果 ok:false「被拒绝」
    expect(envelopes.some((e) => e.type === 'approval_request')).toBe(true);
    expect(envelopes.some((e) => e.type === 'approval_resolved')).toBe(true);
    const toolResult = envelopes.find(
      (e) => e.type === 'tool_result' && e.data.id === 'c1',
    );
    expect(toolResult?.type).toBe('tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.data.ok).toBe(false);
      expect(toolResult.data.forModel).toContain('被拒绝');
    }
  });

  test('autoApprove：exec 工具调用放行并执行', async () => {
    const stub = new StubProvider([
      [
        {
          type: 'tool_use',
          id: 'c1',
          name: 'bash',
          input: { command: 'echo hi' },
        },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish', reason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: '完成。' },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish', reason: 'stop' },
      ],
    ]);
    const { envelopes } = await runHeadless({
      provider: stub,
      prompt: '跑一下',
      tools: defaultWriteTools(),
      autoApprove: true,
      write: () => {},
      writeError: () => {},
    });

    const toolResult = envelopes.find(
      (e) => e.type === 'tool_result' && e.data.id === 'c1',
    );
    expect(toolResult?.type).toBe('tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.data.ok).toBe(true);
    }
  });

  test('危险命令即使 autoApprove 也逐次强制确认：每次都发 approval_request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'modou-headless-danger-'));
    const target = join(dir, 'x');
    try {
      const stub = new StubProvider([
        [
          {
            type: 'tool_use',
            id: 'c1',
            name: 'bash',
            input: { command: `rm -rf ${target}` },
          },
          { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
          { type: 'finish', reason: 'tool_use' },
        ],
        [
          { type: 'text_delta', delta: '完成。' },
          { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
          { type: 'finish', reason: 'stop' },
        ],
      ]);
      const { envelopes } = await runHeadless({
        provider: stub,
        prompt: '删掉',
        tools: defaultWriteTools(),
        autoApprove: true,
        write: () => {},
        writeError: () => {},
      });

      const request = envelopes.find((e) => e.type === 'approval_request');
      expect(request).toBeDefined();
      if (request?.type === 'approval_request') {
        // 危险命令的可选项不含「始终允许此前缀」
        expect(request.data.options.some((o) => o.id === 'allow_always')).toBe(
          false,
        );
        expect(request.data.description).toContain('rm -rf');
      }
      // autoApprove 策略逐次裁决放行，工具实际执行（rm 一个不存在的路径，退出码 0）
      const toolResult = envelopes.find(
        (e) => e.type === 'tool_result' && e.data.id === 'c1',
      );
      expect(toolResult?.type).toBe('tool_result');
      if (toolResult?.type === 'tool_result') {
        expect(toolResult.data.ok).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('approve 回调注入：按回调裁决（source user），优先于 autoApprove', async () => {
    const seen: string[] = [];
    const stub = new StubProvider([
      [
        {
          type: 'tool_use',
          id: 'c1',
          name: 'bash',
          input: { command: 'echo hi' },
        },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish', reason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: '完成。' },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
        { type: 'finish', reason: 'stop' },
      ],
    ]);
    const { envelopes } = await runHeadless({
      provider: stub,
      prompt: '跑一下',
      tools: defaultWriteTools(),
      autoApprove: false,
      approve: (request) => {
        seen.push(request.toolName);
        return Promise.resolve('allow_once' as const);
      },
      write: () => {},
      writeError: () => {},
    });

    expect(seen).toContain('bash');
    const resolved = envelopes.find((e) => e.type === 'approval_resolved');
    expect(resolved?.type).toBe('approval_resolved');
    if (resolved?.type === 'approval_resolved') {
      expect(resolved.data.decision).toBe('allow_once');
      expect(resolved.data.source).toBe('user');
    }
    const toolResult = envelopes.find(
      (e) => e.type === 'tool_result' && e.data.id === 'c1',
    );
    expect(toolResult?.type).toBe('tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.data.ok).toBe(true);
    }
  });
});
