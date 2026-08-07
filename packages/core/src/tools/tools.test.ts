import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { ProtocolEvent } from '../protocol/events';
import { runToolPipeline } from './pipeline';
import { redactSecrets } from './redact';
import { ToolRegistry } from './registry';
import { truncateOutput } from './truncate';
import type { Tool, ToolContext } from './types';

/** 测试用回显工具：原样返回入参文本。 */
const echoTool: Tool = {
  name: 'echo',
  description: '原样返回输入的文本（测试用）',
  risk: 'read',
  schema: z.object({
    text: z.string().min(1),
    times: z.number().int().positive().optional(),
  }),
  execute: async (args: { text: string; times?: number }) => ({
    ok: true,
    forModel:
      args.times !== undefined ? args.text.repeat(args.times) : args.text,
    payload: { echoed: args.text },
  }),
};

function buildRegistry(): ToolRegistry {
  return new ToolRegistry().register(echoTool);
}

function collectEvents(): {
  events: ProtocolEvent[];
  emit: (event: ProtocolEvent) => void;
} {
  const events: ProtocolEvent[] = [];
  return {
    events,
    emit: (event) => {
      events.push(event);
    },
  };
}

function toolResults(events: ProtocolEvent[]): ProtocolEvent[] {
  return events.filter((event) => event.type === 'tool_result');
}

describe('ToolRegistry', () => {
  test('注册 / 查找 / 列出', () => {
    const registry = new ToolRegistry().register(echoTool);
    expect(registry.find('echo')).toBe(echoTool);
    expect(registry.has('echo')).toBe(true);
    expect(registry.has('nope')).toBe(false);
    expect(registry.list()).toEqual([echoTool]);
    expect(registry.names()).toEqual(['echo']);
    expect(registry.size).toBe(1);
  });

  test('同名注册抛错（防静默覆盖）', () => {
    const registry = new ToolRegistry().register(echoTool);
    expect(() => registry.register(echoTool)).toThrow(/重复注册/);
  });

  test('schema 转 JSON Schema 给模型', () => {
    const registry = buildRegistry();
    const schema = registry.toJsonSchema('echo') as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties.text).toBeDefined();
    expect(schema.required).toContain('text');
    expect(() => registry.toJsonSchema('nope')).toThrow(/未知工具/);
  });

  test('未注册工具 find 返回 undefined', () => {
    expect(new ToolRegistry().find('ghost')).toBeUndefined();
  });
});

describe('truncateOutput', () => {
  const makeLines = (count: number, prefix = 'line'): string =>
    Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`).join('\n');

  test('行数超限：保留头尾、中间省略，并写明省略行数', () => {
    const result = truncateOutput(makeLines(20), {
      maxLines: 10,
      headLines: 3,
      tailLines: 3,
    });
    expect(result.info.truncated).toBe(true);
    expect(result.info.omittedLines).toBe(14);
    expect(result.text).toContain('line-1');
    expect(result.text).toContain('line-3');
    expect(result.text).toContain('省略了 14 行');
    expect(result.text).toContain('line-18');
    expect(result.text).toContain('line-20');
    expect(result.text).not.toContain('line-10'); // 中间被省略
  });

  test('字符超限：保留头尾并写明省略字符数', () => {
    const long = 'a'.repeat(100);
    const result = truncateOutput(long, {
      maxChars: 20,
      headChars: 8,
      tailChars: 6,
    });
    expect(result.info.truncated).toBe(true);
    expect(result.info.omittedChars).toBe(86);
    expect(result.text.startsWith('a'.repeat(8))).toBe(true);
    expect(result.text.endsWith('a'.repeat(6))).toBe(true);
    expect(result.text).toContain('省略了 86 字符');
    expect(result.text.length).toBeLessThan(100);
  });

  test('未超限不截断', () => {
    const source = makeLines(5);
    const result = truncateOutput(source, { maxLines: 10 });
    expect(result.info.truncated).toBe(false);
    expect(result.text).toBe(source);
  });

  test('默认上限：600 行保留头尾各 50 行', () => {
    const result = truncateOutput(makeLines(600));
    expect(result.info.truncated).toBe(true);
    expect(result.info.omittedLines).toBe(500);
    expect(result.text).toContain('省略了 500 行');
  });

  test('单行超长走字符级截断', () => {
    const oneLine = 'x'.repeat(1000);
    const result = truncateOutput(oneLine, {
      maxChars: 50,
      headChars: 20,
      tailChars: 20,
    });
    expect(result.info.truncated).toBe(true);
    expect(result.info.omittedChars).toBe(960);
    expect(result.text).toContain('省略了 960 字符');
  });
});

describe('redactSecrets', () => {
  test('OpenAI 风格 sk- key 被替换', () => {
    const out = redactSecrets('key=sk-abc1234567890123456789 继续');
    expect(out).toContain('sk-[REDACTED]');
    expect(out).not.toContain('sk-abc1234567890123456789');
  });

  test('GitHub ghp_ token 被替换', () => {
    const token = 'ghp_'.concat('a'.repeat(30));
    const out = redactSecrets(`token 为 ${token}，请勿外泄`);
    expect(out).not.toContain(token);
    expect(out).toContain('ghp_[REDACTED]');
  });

  test('PEM 私钥整块被替换', () => {
    const pem = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0B',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(`私钥内容：\n${pem}\n结束`);
    expect(out).toContain('[REDACTED_PRIVATE_KEY]');
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0B');
  });

  test('AWS_SECRET_ACCESS_KEY 赋值被替换', () => {
    const out = redactSecrets('AWS_SECRET_ACCESS_KEY=supersecretvalue123');
    expect(out).toContain('AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(out).not.toContain('supersecretvalue123');
  });

  test('AKIA AWS 访问密钥 ID 被替换', () => {
    const out = redactSecrets('aws_key=AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('AKIA[REDACTED]');
  });

  test('普通文本不受影响', () => {
    const plain = '功能说明：读取文件并按行号展示，支持分页。';
    expect(redactSecrets(plain)).toBe(plain);
  });

  test('无赋值的 token 单词不误伤', () => {
    const text = 'the token should be present here';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('runToolPipeline', () => {
  test('成功：执行并发出 tool_call / tool_result', async () => {
    const { events, emit } = collectEvents();
    const outcome = await runToolPipeline(
      { id: 'call-1', name: 'echo', input: { text: '你好' } },
      { registry: buildRegistry(), emit },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.forModel).toBe('你好');
    expect(outcome.payload).toEqual({ echoed: '你好' });

    expect(events[0].type).toBe('tool_call');
    const call = events[0];
    if (call.type === 'tool_call') {
      expect(call.data.id).toBe('call-1');
      expect(call.data.name).toBe('echo');
      expect(call.data.input).toEqual({ text: '你好' });
    }
    const results = toolResults(events);
    expect(results).toHaveLength(1);
    const result = results[0];
    if (result.type === 'tool_result') {
      expect(result.data.id).toBe('call-1');
      expect(result.data.ok).toBe(true);
      expect(result.data.forModel).toBe('你好');
      expect(result.data.payload).toEqual({ echoed: '你好' });
    }
  });

  test('参数错误：ok=false，信息含字段原因与正确用法', async () => {
    const { events, emit } = collectEvents();
    const outcome = await runToolPipeline(
      { id: 'call-2', name: 'echo', input: { text: 123 } },
      { registry: buildRegistry(), emit },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('参数校验失败');
    expect(outcome.forModel).toContain('text');
    expect(outcome.forModel).toContain('正确用法');

    const result = toolResults(events)[0];
    if (result.type === 'tool_result') {
      expect(result.data.ok).toBe(false);
      expect(result.data.forModel).toContain('参数校验失败');
    }
  });

  test('未知工具：ok=false 可诊断，并列出可用工具', async () => {
    const outcome = await runToolPipeline(
      { id: 'call-3', name: 'ghost', input: {} },
      { registry: buildRegistry() },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('未知工具');
    expect(outcome.forModel).toContain('"echo"');
  });

  test('执行错误：工具抛异常转为 ok=false 回喂，不冒泡', async () => {
    const registry = new ToolRegistry().register({
      name: 'boom',
      description: '抛错工具',
      risk: 'read',
      schema: z.object({}),
      execute: async () => {
        throw new Error('磁盘不可写');
      },
    });
    const outcome = await runToolPipeline(
      { id: 'call-4', name: 'boom', input: {} },
      { registry },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('执行出错');
    expect(outcome.forModel).toContain('磁盘不可写');
  });

  test('超时：不配合取消的工具也被按时裁决', async () => {
    const registry = new ToolRegistry().register({
      name: 'sleep',
      description: '永不返回的工具',
      risk: 'read',
      schema: z.object({}),
      execute: async () => {
        await new Promise<void>(() => {});
        return { ok: true, forModel: 'done' };
      },
    });
    const started = performance.now();
    const outcome = await runToolPipeline(
      { id: 'call-5', name: 'sleep', input: {} },
      { registry, timeoutMs: 50 },
    );
    const elapsed = performance.now() - started;
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('超时');
    expect(elapsed).toBeLessThan(1000);
  });

  test('超时：协作取消的工具收到中止的 signal', async () => {
    const registry = new ToolRegistry().register({
      name: 'listener',
      description: '监听 signal 的工具',
      risk: 'read',
      schema: z.object({}),
      execute: async (_args: unknown, ctx: ToolContext) => {
        await new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => reject(ctx.signal.reason),
            { once: true },
          );
        });
        return { ok: true, forModel: 'never' };
      },
    });
    const outcome = await runToolPipeline(
      { id: 'call-6', name: 'listener', input: {} },
      { registry, timeoutMs: 50 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('超时');
  });

  test('外部 abort：ok=false 并写明中断', async () => {
    const registry = new ToolRegistry().register({
      name: 'wait',
      description: '等待 signal 的工具',
      risk: 'read',
      schema: z.object({}),
      execute: async (_args: unknown, ctx: ToolContext) => {
        await new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => reject(ctx.signal.reason),
            { once: true },
          );
        });
        return { ok: true, forModel: 'never' };
      },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const outcome = await runToolPipeline(
      { id: 'call-7', name: 'wait', input: {} },
      { registry, abortSignal: controller.signal, timeoutMs: 5000 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.forModel).toContain('中断');
  });

  test('归一：forModel 脱敏 + 截断并出声', async () => {
    const secretSuffix = 'abcdefghijklmnop';
    const longText = Array.from(
      { length: 600 },
      (_, i) => `行 ${i + 1}：sk-${secretSuffix}${i}`,
    ).join('\n');
    const registry = new ToolRegistry().register({
      name: 'dump',
      description: '输出长文本与密钥',
      risk: 'read',
      schema: z.object({}),
      execute: async () => ({ ok: true, forModel: longText }),
    });
    const { events, emit } = collectEvents();
    const outcome = await runToolPipeline(
      { id: 'call-8', name: 'dump', input: {} },
      { registry, emit },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.forModel).toContain('省略了 500 行');
    expect(outcome.forModel).not.toContain(secretSuffix);
    expect(outcome.forModel).toContain('sk-[REDACTED]');
    expect(outcome.truncated?.truncated).toBe(true);
    expect(outcome.truncated?.omittedLines).toBe(500);

    const result = toolResults(events)[0];
    if (result.type === 'tool_result') {
      expect(result.data.forModel).toContain('省略了 500 行');
      expect(result.data.forModel).not.toContain(secretSuffix);
    }
  });

  test('summary 缺省取 forModel 首行', async () => {
    const { events, emit } = collectEvents();
    const outcome = await runToolPipeline(
      { id: 'call-9', name: 'echo', input: { text: '第一行\n第二行' } },
      { registry: buildRegistry(), emit },
    );
    expect(outcome.ok).toBe(true);
    const result = toolResults(events)[0];
    if (result.type === 'tool_result') {
      expect(result.data.summary).toBe('第一行');
    }
  });

  test('tool_call 入参同样先脱敏再进事件流', async () => {
    const registry = new ToolRegistry().register({
      name: 'echo-input',
      description: '回显入参',
      risk: 'read',
      schema: z.object({ note: z.string() }),
      execute: async (args: { note: string }) => ({
        ok: true,
        forModel: args.note,
      }),
    });
    const { events, emit } = collectEvents();
    await runToolPipeline(
      {
        id: 'call-10',
        name: 'echo-input',
        input: { note: 'sk-hunter1234567890' },
      },
      { registry, emit },
    );
    const call = events[0];
    if (call.type === 'tool_call') {
      expect(call.data.input).toEqual({ note: 'sk-[REDACTED]' });
    }
  });
});
