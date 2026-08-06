import { describe, expect, test } from 'bun:test';
import type { ProviderCapabilities } from '../capabilities';
import { OPENAI_COMPAT_DEFAULT_CAPABILITIES } from '../openai-compat';
import { createProvider, readOpencodeEnv } from '../providers';
import type { ModelProvider, StreamEvent } from '../types';

// ---------------------------------------------------------------------------
// 真实端点冒烟测试（G-0.1.0「真实流式输出」前提的验证）。
//
// 门控：只有 MODOU_OPENCODE_* 四个环境变量全部就绪才真正发请求；
// 否则整组用例 skip —— CI 无密钥时这套测试不依赖外网、静默不跑。
// 本地 .env 已 gitignore，见仓库根 .env（MODOU_OPENCODE_API_KEY 等）。
// ---------------------------------------------------------------------------

const opencodeEnv = readOpencodeEnv();
const hasOpencodeConfig = opencodeEnv !== null;

/** DeepSeek 属国产模型：声明宽松 JSON 与 tagged think（防端点把推理混入正文）。 */
const DEEPSEEK_CAPABILITIES: ProviderCapabilities = {
  ...OPENAI_COMPAT_DEFAULT_CAPABILITIES,
  strictJsonArgs: false,
  thinking: 'tagged',
};

function buildOpencodeProvider(
  modelId: string,
  capabilities?: ProviderCapabilities,
): ModelProvider {
  if (opencodeEnv === null) {
    // 理论上不可达：未配置时用例已 skip，此处仅满足类型收窄
    throw new Error('opencode 环境未配置，用例应当已 skip');
  }
  return createProvider({
    type: 'openai-compat',
    modelId,
    baseURL: opencodeEnv.baseURL,
    apiKey: opencodeEnv.apiKey,
    ...(capabilities === undefined ? {} : { capabilities }),
  });
}

async function collectAll(provider: ModelProvider): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.streamChat({
    messages: [{ role: 'user' as const, content: '用一句话介绍你自己。' }],
  })) {
    events.push(event);
  }
  return events;
}

const TIMEOUT_MS = 60_000;

describe('真实端点冒烟测试（G-0.1.0 前提：真实流式输出）', () => {
  test.skipIf(!hasOpencodeConfig)(
    `DeepSeek（${opencodeEnv?.deepseekModel ?? 'deepseek-v4-flash'}）流式输出非空文本`,
    async () => {
      const provider = buildOpencodeProvider(
        opencodeEnv!.deepseekModel,
        DEEPSEEK_CAPABILITIES,
      );
      const events = await collectAll(provider);

      const text = events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.delta)
        .join('');
      expect(text.length).toBeGreaterThan(0);
      expect(events.some((event) => event.type === 'usage')).toBe(true);
      expect(events[events.length - 1]?.type).toBe('finish');
    },
    TIMEOUT_MS,
  );

  test.skipIf(!hasOpencodeConfig)(
    `GPT（${opencodeEnv?.gptModel ?? 'gpt-5.6-luna'}）流式输出非空文本`,
    async () => {
      const provider = buildOpencodeProvider(opencodeEnv!.gptModel);
      const events = await collectAll(provider);

      const text = events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.delta)
        .join('');
      expect(text.length).toBeGreaterThan(0);
      expect(events.some((event) => event.type === 'usage')).toBe(true);
      expect(events[events.length - 1]?.type).toBe('finish');
    },
    TIMEOUT_MS,
  );
});
