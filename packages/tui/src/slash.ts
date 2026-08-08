/**
 * 斜杠命令框架（T-082）：命令表 + 分发器 + /model 候选 / model_switch 解析。
 *
 * runTui 的 handleSlash 只是一个薄壳：解析出 name/args 后交给 `dispatchSlash`
 * 按命令表分发到各实现（/help /model /compact /resume /context /clear），
 * 未实现命令统一发「尚未实现」notice。命令的**实现**仍留在 runTui（持有
 * provider / 会话 / 历史等闭包状态），本模块只负责「分发」本身——把命令名到
 * 处理器的映射收窄到一张表，避免 runTui 里堆一串 if（002 3.3 表：slash 是
 * 前端唯一命令入口，命令集必须可枚举、可测试）。
 *
 * 0.8.0 命令集（T-082；自定义斜杠命令 0.11.0 由 Config 注入，见 002 十节）：
 * - /help     列出全部命令与用法；
 * - /model    切换模型（无参数打开候选列表，直接传 ID 立即切换；上下文延续）；
 * - /compact  手动压缩（T-070 已有，纳入框架）；
 * - /resume   恢复会话（T-061 已有，纳入框架）；
 * - /context  上下文用量视图（T-063 已有，纳入框架）；
 * - /clear    清空当前会话上下文并开启新会话（原日志保留）。
 *
 * 纯函数（无 React / Ink 依赖），可直接单元测试。
 */

import type {
  CustomCommandFile,
  ModelProvider,
  SessionRecord,
} from '@modou/core';
import type { McpServerStatus } from '@modou/core';
import type { CostTotals, DayCostTotals } from '@modou/core';

// ---------------------------------------------------------------------------
// 命令表（/help 的数据源；新命令先加在这里，再在 dispatchSlash 加一行）
// ---------------------------------------------------------------------------

/** 一条内置斜杠命令的元信息。 */
export interface SlashCommandInfo {
  /** 命令名（不带 `/` 前缀）。 */
  readonly name: string;
  /** 用法示例（含 `/` 前缀与参数占位）。 */
  readonly usage: string;
  /** 一句话描述（/help 展示）。 */
  readonly description: string;
}

/** 0.8.0 内置斜杠命令表（T-082；顺序即 /help 展示顺序）。 */
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
      'load <路径> 从 markdown 文件读回计划（手动编辑后再执行）',
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

/**
 * /help 的展示文本（notice 载荷）：一行标题 + 每命令一行「usage — description」。
 * 可附加自定义命令（T-114：`.modou/commands/*.md` 加载的命令，usage = `/名`）。
 */
export function renderHelpText(
  extraCommands: readonly SlashCommandInfo[] = [],
): string {
  const lines = [
    '斜杠命令：',
    ...BUILTIN_SLASH_COMMANDS.map(
      (command) => `  ${command.usage}  — ${command.description}`,
    ),
    ...extraCommands.map(
      (command) => `  ${command.usage}  — ${command.description}`,
    ),
  ];
  return lines.join('\n');
}

/** 自定义命令 → SlashCommandInfo（/help 展示 + 输入补全共用）。 */
export function customToCommandInfo(
  command: CustomCommandFile,
): SlashCommandInfo {
  return {
    name: command.name,
    usage: `/${command.name} [参数…]`,
    description: command.description,
  };
}

// ---------------------------------------------------------------------------
// /cost（T-134）：成本报告渲染
// ---------------------------------------------------------------------------

/** token 数 → 可读（K / M 后缀；小数一位）。 */
export function formatCostTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

/** 费用（USD）→ 可读（$ 前缀；未定价时返回 '$?'）。 */
export function formatCostMoney(cost: number | undefined): string {
  if (cost === undefined) return '$?';
  // 小额显示 4 位小数，大额保留整数级精度
  const text = cost > 0 && cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2);
  return `$${text}`;
}

/** /cost 报告渲染（纯函数，可离线测试）。 */
export function renderCostReport(options: {
  readonly modelId: string;
  readonly sessionId: string;
  readonly session: CostTotals;
  readonly byDay: readonly DayCostTotals[];
}): string {
  const lines = [`成本统计（模型 ${options.modelId}）：`];
  const priceNote = options.session.priced
    ? ''
    : '（当前模型无定价——只报 token，费用按供应商账单为准）';
  const session = options.session;
  lines.push(
    `  本会话 ${options.sessionId}：${session.requests} 次请求 · ` +
      `in ${formatCostTokens(session.inputTokens)} / ` +
      `out ${formatCostTokens(session.outputTokens)} tokens · ` +
      `${formatCostMoney(session.totalCost)}${priceNote}`,
  );
  if (options.byDay.length > 0) {
    lines.push('  按天：');
    for (const day of options.byDay) {
      lines.push(
        `    ${day.day}：${day.requests} 次请求 · ` +
          `in ${formatCostTokens(day.inputTokens)} / ` +
          `out ${formatCostTokens(day.outputTokens)} tokens · ` +
          `${formatCostMoney(day.totalCost)}`,
      );
    }
    const totalCost = options.byDay.reduce<number | undefined>(
      (sum, day) =>
        day.totalCost === undefined ? sum : (sum ?? 0) + day.totalCost,
      undefined,
    );
    lines.push(`  全部会话合计：${formatCostMoney(totalCost)}`);
  } else {
    lines.push('  按天：尚无用量记录');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// /mcp（T-163）：MCP 服务器连接状态报告渲染
// ---------------------------------------------------------------------------

/** 状态 → 中文标签（/mcp 展示）。 */
const MCP_STATE_LABEL: Readonly<Record<McpServerStatus['state'], string>> = {
  disconnected: '已断开（等待重连）',
  connecting: '连接中',
  connected: '已连接',
  failed: '连接失败',
};

/**
 * /mcp 报告渲染（纯函数，可离线测试）：每 server 一行——名称 [传输] 状态 ·
 * 服务器身份 · 工具数 · 错误（失败/断开时）。未配置 server 时给明确说明。
 */
export function renderMcpStatus(
  statuses: readonly McpServerStatus[],
  activeToolCount: number,
): string {
  if (statuses.length === 0) {
    return 'MCP：未配置服务器（settings.json mcp.servers 为空）。';
  }
  const lines = [
    `MCP 服务器（${statuses.length} 个，已注册工具 ${activeToolCount} 个）：`,
  ];
  for (const status of statuses) {
    const parts = [
      `${status.name} [${status.transport}] ${MCP_STATE_LABEL[status.state]}`,
    ];
    if (status.state === 'connected') {
      const info =
        status.serverInfo !== undefined
          ? `${status.serverInfo.name} ${status.serverInfo.version}`
          : '未知身份';
      parts.push(`${info} · ${status.toolCount} 个工具`);
    } else if (status.state === 'failed' || status.state === 'disconnected') {
      parts.push(`（${status.error ?? '原因未知'}）`);
    }
    lines.push(`  ${parts.join('  ')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 分发器
// ---------------------------------------------------------------------------

/** 各命令的实现回调（由 runTui 以闭包提供；测试注入替身断言分发）。 */
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
  /** /init（T-132）：探测仓库 → 生成 AGENTS.md 初稿（预览后写入）。 */
  readonly init: () => void;
  /** /image（T-133）：以图片输入发起一轮（文件路径 / URL 作为多模态附件）。 */
  readonly image: (args?: string) => void;
  /** /cost（T-134）：成本统计（本会话 + 按天；按当前模型定价）。 */
  readonly cost: () => void;
  /** /mcp（T-163）：查看 MCP 服务器连接状态（已连接 / 重连 / 失败）。 */
  readonly mcp: () => void;
  /**
   * 自定义命令处理器（T-114）：dispatchSlash 未命中内置命令时，在 customCommands
   * 表中查找并回调（runTui 负责展开占位 / 工具白名单 / 默认模型）。缺省不提供。
   */
  readonly custom?: (command: CustomCommandFile, args?: string) => void;
}

/**
 * 斜杠命令分发：按命令名把 (name, args) 路由到对应处理器。
 *
 * - 命中内置命令 → 调对应处理器，返回 true；
 * - 未命中内置但命中自定义命令表（T-114，customCommands）→ 调 handlers.custom，
 *   返回 true；
 * - 都没命中 → 调 onUnimplemented（runTui 发「尚未实现」notice），返回 false。
 *
 * 分发与实现分离：本函数可离线单测（替身回调断言每个命令的分发），
 * 实现细节（provider / 会话状态）留在 runTui。
 */
export function dispatchSlash(
  name: string,
  args: string | undefined,
  handlers: SlashHandlers,
  onUnimplemented: (name: string, args: string | undefined) => void,
  customCommands: readonly CustomCommandFile[] = [],
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
    default: {
      // T-114 自定义斜杠命令：未命中内置 → 在命令表中查找，命中回调 handlers.custom
      const custom = customCommands.find((command) => command.name === name);
      if (custom !== undefined) {
        handlers.custom?.(custom, args);
        return true;
      }
      onUnimplemented(name, args);
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// /model 辅助
// ---------------------------------------------------------------------------

/**
 * 收集 /model 候选模型 ID（选择器列表）：当前模型 → 环境变量派生的模型 →
 * 已知缺省锚点，去重保序。
 *
 * 环境变量来源：MODOU_MODEL / MODOU_OPENCODE_MODEL / MODOU_TEST_MODEL_DEEPSEEK
 * / MODOU_TEST_MODEL_GPT / OPENAI_MODEL / ANTHROPIC_MODEL（与
 * createProviderFromConfig 的环境回落同源）。缺省锚点保证列表非空（空环境时
 * 用户仍能一键切到常见模型）。
 */
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

/**
 * 从会话记录里找最后一条 model_switch 的目标模型（/resume 恢复模型用；
 * 002 8.2「切换入日志，resume 后正确」）。无 model_switch 记录返回 undefined。
 */
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
