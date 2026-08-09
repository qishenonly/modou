/**
 * 斜杠命令框架（与 packages/tui/src/slash.ts 同源，命令表对齐 0.17.0）。
 *
 * GUI 的分工与 TUI 一致：分发器只做「命令名 → 处理器」的映射（002 3.3 表：
 * slash 是前端唯一命令入口，命令集必须可枚举、可测试），命令**实现**留在
 * GuiBridge（持有 provider / 会话 / 快照 / 计划模式等闭包状态）。渲染进程侧
 * 的 UI 模态（模型 / 会话 / 上下文 / 快照 / 计划 / 成本 / MCP / init）由渲染
 * 进程驱动：无参 `/model`、`/resume`、`/context`、`/rewind`、`/snapshots`、
 * `/plan`、`/cost`、`/mcp`、`/init` 由渲染进程打开对应面板，带参命令与
 * `/compact`、`/clear`、`/image` 走本分发器。
 */
import type { ModelProvider, SessionRecord } from '@modou/core';

/** 一条内置斜杠命令的元信息。 */
export interface SlashCommandInfo {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
}

/** 内置斜杠命令表（对齐 0.17.0 全部内置命令；顺序即 /help 展示顺序）。 */
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommandInfo[] = [
  {
    name: 'help',
    usage: '/help',
    description: '列出全部斜杠命令与用法',
  },
  {
    name: 'model',
    usage: '/model [模型ID]',
    description:
      '切换模型（无参数打开候选列表；直接传 ID 立即切换，上下文延续）',
  },
  {
    name: 'compact',
    usage: '/compact',
    description: '手动触发一次上下文压缩（折叠早期轮次进摘要）',
  },
  {
    name: 'resume',
    usage: '/resume [会话ID]',
    description: '恢复已保存会话（无参数列出候选；带 ID 直接恢复）',
  },
  {
    name: 'context',
    usage: '/context [--json]',
    description: '查看上下文用量分项（--json 输出机器可读核算）',
  },
  {
    name: 'clear',
    usage: '/clear',
    description:
      '清空当前会话上下文并开启新会话（原会话日志保留，/resume 可恢复）',
  },
  {
    name: 'rewind',
    usage: '/rewind',
    description:
      '列出快照点，选择后预览差异并还原文件（回滚到该点，撤销之后的改动）',
  },
  {
    name: 'snapshots',
    usage: '/snapshots [--cleanup]',
    description: '查看快照占用与保留策略（--cleanup 触发一次过期清理）',
  },
  {
    name: 'plan',
    usage: '/plan [请求 | load <路径>]',
    description:
      '计划模式：只读研究 → 结构化计划 → 批准/修改/拒绝（批准后切执行模式）；' +
      'load <路径> 从 markdown 文件读回计划',
  },
  {
    name: 'init',
    usage: '/init',
    description:
      '分析仓库结构，生成 AGENTS.md 初稿（预览后写入；已存在则不覆盖）',
  },
  {
    name: 'image',
    usage: '/image <文件路径 | URL>',
    description:
      '以图片输入发起一轮：文件路径或 URL 作为多模态附件（不支持图片的模型会降级说明）',
  },
  {
    name: 'cost',
    usage: '/cost',
    description:
      '成本统计：本会话与按天的 token / 费用（按当前模型定价，未知模型只报 token）',
  },
  {
    name: 'mcp',
    usage: '/mcp',
    description:
      '查看 MCP 服务器连接状态（已连接 / 断开重连 / 失败，各服务器工具数）',
  },
];

/** 未实现命令 notice 里列出的已支持命令。 */
export const SUPPORTED_SLASH_LIST = BUILTIN_SLASH_COMMANDS.map(
  (command) => `/${command.name}`,
).join('、');

/** /help 的展示文本。 */
export function renderHelpText(): string {
  const lines = [
    '斜杠命令：',
    ...BUILTIN_SLASH_COMMANDS.map(
      (command) => `  ${command.usage}  — ${command.description}`,
    ),
  ];
  return lines.join('\n');
}

/** 各命令的实现回调（由 GuiBridge 以闭包提供）。 */
export interface SlashHandlers {
  readonly help: () => void;
  readonly model: (args?: string) => void;
  readonly compact: () => void;
  readonly resume: (args?: string) => void;
  readonly context: (args?: string) => void;
  readonly clear: () => void;
  readonly rewind: () => void;
  readonly snapshots: (args?: string) => void;
  readonly plan: (args?: string) => void;
  readonly init: () => void;
  readonly image: (args?: string) => void;
  readonly cost: () => void;
  readonly mcp: () => void;
}

/** 斜杠命令分发：命中内置命令 → 调对应处理器返回 true；否则调 onUnimplemented。 */
export function dispatchSlash(
  name: string,
  args: string | undefined,
  handlers: SlashHandlers,
  onUnimplemented: (name: string, args: string | undefined) => void,
): boolean {
  switch (name) {
    case 'help':
      handlers.help();
      return true;
    case 'model':
      handlers.model(args);
      return true;
    case 'compact':
      handlers.compact();
      return true;
    case 'resume':
      handlers.resume(args);
      return true;
    case 'context':
      handlers.context(args);
      return true;
    case 'clear':
      handlers.clear();
      return true;
    case 'rewind':
      handlers.rewind();
      return true;
    case 'snapshots':
      handlers.snapshots(args);
      return true;
    case 'plan':
      handlers.plan(args);
      return true;
    case 'init':
      handlers.init();
      return true;
    case 'image':
      handlers.image(args);
      return true;
    case 'cost':
      handlers.cost();
      return true;
    case 'mcp':
      handlers.mcp();
      return true;
    default:
      onUnimplemented(name, args);
      return false;
  }
}

/** 收集 /model 候选模型 ID（当前模型 → 环境变量派生 → 已知缺省锚点，去重保序）。 */
export function collectModelCandidates(
  provider: ModelProvider,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const candidates: Array<string | undefined> = [
    provider.modelId,
    env.MODOU_MODEL,
    env.MODOU_OPENCODE_MODEL,
    env.MODOU_TEST_MODEL_DEEPSEEK,
    env.MODOU_TEST_MODEL_GPT,
    env.OPENAI_MODEL,
    env.ANTHROPIC_MODEL,
    'gpt-4o',
    'claude-sonnet-4-5',
  ];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of candidates) {
    if (
      candidate === undefined ||
      candidate.trim().length === 0 ||
      seen.has(candidate)
    ) {
      continue;
    }
    seen.add(candidate);
    unique.push(candidate);
  }
  return unique;
}

/** 从会话记录里找最后一条 model_switch 的目标模型（/resume 恢复模型用；002 8.2）。 */
export function lastModelSwitchTo(
  records: readonly SessionRecord[],
): string | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.kind === 'model_switch') return record.data.to;
  }
  return undefined;
}

/** 归一任意错误为可读文本（/model 重建 provider 失败 notice 用）。 */
export function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
