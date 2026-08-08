import { createElement, type ReactElement } from 'react';
import { render, type Instance } from 'ink';
import {
  aggregateByDay,
  aggregateCost,
  attachImagesToUserMessage,
  buildContextState,
  buildSystemPrompt,
  BudgetLedger,
  collectTouchedPaths,
  countUserMessages,
  createModelDeltaGenerator,
  createProviderFromConfig,
  createAgentTool,
  createSkillTool,
  defaultReadonlyTools,
  DEFAULT_MIN_TURNS_BETWEEN_COMPACTIONS,
  discoverAgents,
  discoverSkills,
  loadMemoryText,
  memoryDirFor,
  withMemoryTools,
  withWebTools,
  EnvelopeLogAdapter,
  expandCommandPlaceholders,
  isEmptyPlan,
  listSessionsForResume,
  loadCustomCommands,
  loadInstructions,
  loadPlanFromFile,
  McpManager,
  normalizeMcpServers,
  parseStructuredPlan,
  PLAN_MODE_INSTRUCTION,
  planReadonlyRegistry,
  projectHash,
  projectMessages,
  rebuildReadFiles,
  rebuildStructuredPlan,
  rebuildSummaryState,
  rebuildTodoState,
  resumeSession,
  runAgentTurnStreaming,
  runInit,
  runUserPromptSubmit,
  savePlanToFile,
  serializeStructuredPlan,
  SessionLog,
  SessionStore,
  SnapshotStore,
  ToolRegistry,
  toOnFileWrite,
  usageEntriesFromRecords,
  WriteConflictDetector,
} from '@modou/core';
import type {
  AttachmentRef,
  Command,
  CompactOptions,
  CompactionData,
  ContextStateData,
  CustomCommandFile,
  Envelope,
  ModelMessage,
  ModelProvider,
  NoticeLevel,
  ResumeCandidate,
  RewindPreview,
  AgentToolDeps,
  SessionRecord,
  SkillToolDeps,
  SnapshotPoint,
  StructuredPlan,
  SummaryState,
  TimestampedUsage,
  TodoState,
} from '@modou/core';
import { App } from './app';
import { createApprovalBridge } from './approval';
import { performCompact } from './compact';
import {
  BUILTIN_SLASH_COMMANDS,
  collectModelCandidates,
  customToCommandInfo,
  describeError,
  dispatchSlash,
  lastModelSwitchTo,
  renderCostReport,
  renderHelpText,
  renderMcpStatus,
  SUPPORTED_SLASH_LIST,
} from './slash';
import type { SlashHandlers } from './slash';
import { derivePermissionMode, type TokenTotals } from './status';
import { createEventChannel } from './stream';
import { assembleTuiStartup, type TuiOptions } from './startup';

export const version = '0.17.0';

/** runTui 的产出。 */
export interface TuiResult {
  /**
   * 退出码：Ctrl+C 交互式退出为 0（用户主动结束 TUI，同 vim/less 惯例）；
   * 收到 SIGINT 外部信号退出为 130（POSIX 128+2，与 headless 一致）。
   */
  readonly exitCode: number;
}

/** 缺省压缩触发阈值：上下文窗口的 70% 折（002 7.1 触发点；maxContext 缺失时 60_000）。 */
function defaultCompactionThreshold(provider: ModelProvider): number {
  const maxContext = provider.capabilities.maxContext;
  if (
    typeof maxContext === 'number' &&
    Number.isFinite(maxContext) &&
    maxContext > 0
  ) {
    return Math.floor(maxContext * 0.7);
  }
  return 60_000;
}

/**
 * TUI 入口：装配 provider → 建立事件流 → 渲染 App → 把 Command 回传给 core。
 *
 * 依赖方向：tui 只 import core 的公开 API（协议事件 / runAgentTurnStreaming /
 * Command 构造），core 零 UI 依赖由 T-003 守卫；这里是 tui→core 的正当消费。
 *
 * 生命周期：
 * - 事件流：createEventChannel 适配 runAgentTurnStreaming 的回调为 App 可消费的
 *   AsyncIterable；多轮 turn 复用同一事件流，退出时 end() 让 App 干净收尾；
 * - Command：submit 触发一轮新 turn（运行中忽略，T-041 完善排队/并入）；每次
 *   submit 传入「完整历史 + 新增 user 消息」，会话日志（T-060）旁路记录本轮，
 *   轮次结束后从日志重新投影历史（T-061：日志是唯一真相），供下一次续写；
 *   interrupt 打断当前轮（每轮独立 AbortController，Esc 不会污染后续 turn）；
 *   approve 由审批桥裁决（用户从弹窗选择 → resolve decider，T-044）；
 *   slash：/resume 列出会话 → 选择器选择 → 恢复并继续对话（同一日志文件续写，
 *   seq 延续；readFiles/usage 一并重建），其余斜杠命令 0.6.0 暂未实现；
 * - 退出：Ctrl+C 经 App.onExit 走 finish(0)；SIGINT 信号走 finish(130)。
 *   两者都先打断在跑的轮次、以 deny 清空未裁决的审批请求、移除信号监听、
 *   结束事件流、卸载 Ink，保证状态干净无悬挂。
 */

// ---------------------------------------------------------------------------
// 备用屏幕（Claude Code 式全屏）
// ---------------------------------------------------------------------------

/** 进入备用屏幕缓冲：接管整个终端、隐藏滚动历史（vim / less / Claude Code 惯例）。 */
const ALT_SCREEN_ENTER = '\x1b[?1049h';
/** 离开备用屏幕：恢复进入前的终端画面（回到 shell 提示符与历史）。 */
const ALT_SCREEN_LEAVE = '\x1b[?1049l';
/** 终端标题（OSC 0）：运行期间显示 modou，退出清除让 shell 下次提示符重设。 */
const TITLE_SET = '\x1b]0;modou\x07';
const TITLE_CLEAR = '\x1b]0;\x07';

/** 若 stdout 是 TTY（真实终端），进入备用屏幕并设置标题。测试/管道不启用（isTTY 为假）。 */
function enterAltScreen(stdout: NodeJS.WriteStream | undefined): void {
  const out = stdout ?? process.stdout;
  if (out.isTTY === true) {
    out.write(ALT_SCREEN_ENTER);
    out.write(TITLE_SET);
  }
}

/** 若 stdout 是 TTY，离开备用屏幕并清除标题（与 enterAltScreen 成对，退出时调用）。 */
function leaveAltScreen(stdout: NodeJS.WriteStream | undefined): void {
  const out = stdout ?? process.stdout;
  if (out.isTTY === true) {
    out.write(TITLE_CLEAR);
    out.write(ALT_SCREEN_LEAVE);
  }
}

/**
 * 在既有工具集上追加 skill 工具（0.15.0 T-152）：复制注册表 + 注册 Skill 工具。
 * 复制而非原地注册——不修改调用方传入的注册表（options.tools 是调用方资产，
 * 自定义斜杠命令 / Plan Mode 白名单 / 权限模式推导都以本函数产出的副本为准）。
 */
function withSkillTool(
  registry: ToolRegistry,
  deps: SkillToolDeps,
): ToolRegistry {
  const copy = new ToolRegistry();
  for (const tool of registry.list()) copy.register(tool);
  copy.register(createSkillTool(deps));
  return copy;
}

/**
 * 在既有工具集上追加 agent 工具（0.17.0 T-170）：复制注册表 + 注册 agent 工具。
 * 与 withSkillTool 同一约定（复制而非原地注册——不修改调用方资产）。有可用
 * 角色时才注册（没有角色时模型调用只会得到「没有可用角色」，不必暴露该工具）。
 */
function withAgentTool(
  registry: ToolRegistry,
  deps: AgentToolDeps,
): ToolRegistry {
  const copy = new ToolRegistry();
  for (const tool of registry.list()) copy.register(tool);
  copy.register(createAgentTool(deps));
  return copy;
}

/**
 * 复制注册表（0.16.0 MCP 注入用）：把调用方的注册表复制一份再向其中注册 MCP
 * 工具——不修改调用方传入的注册表（options.tools 是调用方资产，与 withSkillTool
 * 同一约定）。MCP 工具是异步注入（连接后注册），必须落在副本上。
 */
function copyTools(source: ToolRegistry): ToolRegistry {
  const copy = new ToolRegistry();
  for (const tool of source.list()) copy.register(tool);
  return copy;
}

export async function runTui(options: TuiOptions = {}): Promise<TuiResult> {
  // T-080 配置装配：内置默认 → ~/.modou/settings.json → <project>/.modou/settings.json
  // → MODOU_* 环境变量 → 显式选项（最高优先）；provider / permission / maxTurns /
  // keepTurns / homeDir 全部来自装配结果。
  const startup = assembleTuiStartup(options);
  // 当前 provider 实例（T-082 /model：会话中途换模型 = 换实例，002 8.2；
  // let 供切换后重建并接续）。
  let provider: ModelProvider = startup.provider;
  const cwd = startup.projectRoot;
  const homeDir = startup.homeDir;
  // 0.15.0 Skills（T-151/T-152）：三级发现（仓库内置 skills/ < 全局
  // ~/.modou/skills < 项目 .modou/skills，后者覆盖前者）→ 渐进式披露——
  // 只有 name + description 进系统提示词清单，正文由模型按需通过 skill 工具
  // 加载（触发判断由模型做，ADR 0014）。有可用技能时才注册 skill 工具并渲染
  // 清单（没有技能时模型调用只会得到「无可用技能」，不必暴露该工具）。
  const discoveredSkills = discoverSkills({ homeDir, projectRoot: cwd });
  const skillIndex = new Map(
    discoveredSkills.map((skill) => [skill.name, skill] as const),
  );
  const skillsEnabled = skillIndex.size > 0;
  // 0.16.0 MCP：settings.json mcp.servers 配置（显式覆盖 > 配置解析）。
  // 启用 MCP 时工具注册表先复制一份——连接后向其中批量注入 MCP 工具，
  // 不修改调用方资产（options.tools，与 withSkillTool 同一约定）。
  const mcpServers =
    startup.mcp === undefined ? [] : normalizeMcpServers(startup.mcp);
  let tools = options.tools ?? defaultReadonlyTools();
  if (mcpServers.length > 0) tools = copyTools(tools);
  if (skillsEnabled) {
    tools = withSkillTool(tools, {
      resolve: (name) => skillIndex.get(name),
      names: () => [...skillIndex.keys()],
    });
  }
  // 0.17.0 自定义 agents（T-170）：两级发现（全局 ~/.modou/agents < 项目
  // .modou/agents，项目覆盖全局）→ 角色清单进系统提示词（name + description，
  // 角色提示词派发时注入），模型据清单调 agent 工具按名派发（角色化子代理，
  // 白名单真正强制 + 可选模型指定）。有可用角色时才注册 agent 工具并渲染清单
  // （没有角色时模型调用只会得到「没有可用角色」，不必暴露该工具）。
  const discoveredAgents = discoverAgents({ homeDir, projectRoot: cwd });
  const agentIndex = new Map(
    discoveredAgents.agents.map((agent) => [agent.name, agent] as const),
  );
  const agentsEnabled = agentIndex.size > 0;
  if (agentsEnabled) {
    tools = withAgentTool(tools, {
      resolve: (name) => agentIndex.get(name),
      names: () => [...agentIndex.keys()],
    });
  }
  // 0.17.0 联网工具（T-171 WebFetch / T-172 WebSearch）：settings.json web 键 →
  // 域名过滤配置（白名单/黑名单 + 超时）。联网默认需批准由权限模型 risk=network
  // 兜底；这里把联网工具注册进工具集，域名过滤在工具执行点生效（配置层二次过滤）。
  // T-172 起 withWebTools 同时注册 websearch。
  tools = withWebTools(tools, startup.web);
  // T-114 自定义斜杠命令：加载 `.modou/commands/*.md`（frontmatter + 正文提示词）。
  // 与内置命令同名的文件被跳过并记录（不静默，启动时发 notice 告知）。
  const loadedCommands = await loadCustomCommands(cwd);
  const customCommands = loadedCommands.commands;
  const customCommandInfos = customCommands.map(customToCommandInfo);
  // 输入框补全候选：内置 + 自定义命令（`/name` 形态，T-114）。
  const slashCompletion: readonly string[] = [
    ...BUILTIN_SLASH_COMMANDS.map((command) => `/${command.name}`),
    ...customCommands.map((command) => `/${command.name}`),
  ];
  // T-081 指令文件加载：AGENTS.md 三级指令（全局 → 项目根 → 子目录，002 九节），
  // 渲染结果拼进系统提示词 extra（options.system 显式提供时视为用户接管提示词，
  // 不注入）；超限截断的告警文本留待 pushNotice 就绪后发出——不静默，用户要能
  // 看到自己哪份指令文件没生效。
  const instructions =
    options.system === undefined ? loadInstructions({ homeDir, cwd }) : null;
  // 0.17.0 T-173 长期记忆：项目 `.modou/memory/` 的结构化笔记（ADR 0016 不上向量库）。
  // 新会话启动加载全部记忆注入系统提示词（loadMemoryText，总量上限内、最近写入
  // 优先）；会话内由 memory_read/write/list 工具读写。记忆目录按需创建（工具写入
  // 会 mkdir），因此恒注册记忆工具组——即使当前没有记忆，本会话也可以记录第一条。
  const memoryDir = memoryDirFor(cwd);
  const memoryLoaded = loadMemoryText(memoryDir);
  const memoryText =
    memoryLoaded.text.length > 0 ? memoryLoaded.text : undefined;
  tools = withMemoryTools(tools, { dir: memoryDir });
  // 基准系统提示词（正常执行模式的稳定前缀）；T-112 Plan Mode 进入/退出时
  // 在 system 与 baseSystem 之间切换（let 供切换）。技能清单（0.15.0）作为
  // 稳定前缀的一部分常驻——只有 name + description，正文按需由 skill 工具注入。
  // 0.16.0 MCP：连接完成后重建（MCP 工具定义进「可用工具」段），构造收成函数。
  const extraParts: string[] = [];
  if (instructions !== null && instructions.text.length > 0) {
    extraParts.push(instructions.text);
  }
  if (memoryText !== undefined) extraParts.push(memoryText);
  const extra = extraParts.length > 0 ? extraParts.join('\n\n') : undefined;
  const buildBaseSystem = (): string =>
    options.system ??
    buildSystemPrompt({
      tools,
      ...(extra !== undefined ? { extra } : {}),
      ...(skillsEnabled
        ? {
            skills: discoveredSkills.map((skill) => ({
              name: skill.name,
              description: skill.description,
            })),
          }
        : {}),
      ...(agentsEnabled
        ? {
            agents: discoveredAgents.agents.map((agent) => ({
              name: agent.name,
              description: agent.description,
            })),
          }
        : {}),
    });
  let baseSystem = buildBaseSystem();
  let system = baseSystem;
  const readFiles = new Set(options.readFiles ?? []);
  const channel = createEventChannel();
  // T-123 写冲突检测接入（0.12.1 修复）：会话级检测器——主代理与子代理的每次
  // 成功写入按自身 agent 上报（主 'main' / 子代理 ID），同一文件被多个 agent
  // 写入时检出新写与既有写的冲突并下发 notice(warn) 告知前端（改动可能互相
  // 覆盖，需人工核对）。跨轮次持续（同一实例传给每一轮）。
  const writeConflicts = new WriteConflictDetector();
  const emitter = options.signalEmitter ?? process;
  // T-050：权限组合来自配置装配（内置默认 workspace-write + on-request，与
  // headless 一致）；projectRoot 取 cwd；矩阵 allow/deny 由 gate 内部裁决，
  // ask 才轮到弹窗。
  const permission = startup.permission;
  // 审批桥（T-044）：TUI 的 `approve` Command → ApprovalGate decider 的裁决。
  // decider 对每个请求挂起等待用户从弹窗选择；退出时 denyAll 清空未裁决请求，
  // 防止 pending 审批悬挂导致轮次永不结束。
  const approval = createApprovalBridge(permission);
  // 钩子总线（0.14.0）：显式注入（TuiOptions.hooks）优先，否则按 settings.json
  // hooks 键装配（startup.hooks，T-143）。提供时：管线 ④⑦ 挂载钩子、用户提交
  // 提示词走 UserPromptSubmit。
  const hooksBus = options.hooks ?? startup.hooks;

  // —— 会话（T-060 旁路记录 / T-061 /resume）——
  const sessionStore = new SessionStore({ homeDir });
  // 快照引擎（T-102 /rewind / T-103 /snapshots）：影子 git 仓库——自动快照 +
  // 手动回滚 + 生命周期清理。cwd 即项目根（工作树），与日志同项目哈希。
  // 保留策略 / 降级阈值来自配置（settings.json snapshot 键 / TuiOptions.snapshot），
  // 缺省引擎内置默认。
  const snapshotConfig = startup.snapshot;
  const snapshotEnabled = snapshotConfig?.enabled ?? true;
  const snapshotStore = new SnapshotStore({
    homeDir,
    cwd,
    ...(snapshotConfig !== undefined
      ? {
          retention: {
            ...(snapshotConfig.maxAgeDays !== undefined
              ? { maxAgeMs: snapshotConfig.maxAgeDays * 24 * 60 * 60 * 1000 }
              : {}),
            ...(snapshotConfig.keepPerSession !== undefined
              ? { keepPerSession: snapshotConfig.keepPerSession }
              : {}),
            ...(snapshotConfig.maxPerProject !== undefined
              ? { maxPerProject: snapshotConfig.maxPerProject }
              : {}),
          },
          limits: {
            ...(snapshotConfig.maxChangedPaths !== undefined
              ? { maxChangedPaths: snapshotConfig.maxChangedPaths }
              : {}),
            ...(snapshotConfig.maxBytes !== undefined
              ? { maxBytes: snapshotConfig.maxBytes }
              : {}),
          },
        }
      : {}),
  });
  // 当前会话日志：新建会话（缺省 sessionId）或 resume 续开（指定 sessionId）。
  let sessionLog: SessionLog | null = null;
  // 完整历史消息：每次轮次结束后从会话日志重新投影（002 4.1 日志是唯一真相），
  // 下一次 submit 把「完整历史 + 新增 user 消息」一起发给模型。
  let historyMessages: readonly ModelMessage[] = [];
  // 已入日志的 user 消息条数：续写时传给 loop 的 loggedUserCount（loop 据此只
  // 记录新增段，历史不重复落盘）。
  let loggedUserCount = 0;
  // 历史投影 promise：串行化——下一次提交前确保上一轮投影已完成。
  let historyRefresh: Promise<void> = Promise.resolve();
  // /resume 选择器候选（非空 = App 显示会话选择器）。
  let resumeCandidates: readonly ResumeCandidate[] = [];
  // /model 选择器候选（T-082：非空 = App 显示模型选择器；slash.ts 收集）。
  let modelCandidates: readonly string[] = [];
  // /rewind（T-102）：非空 = App 显示快照选择器；rewindTarget 非空 = 确认态
  // （用户已选中快照点，展示回滚预览等待确认）。
  let snapshotCandidates: readonly SnapshotPoint[] = [];
  let rewindTarget: { point: SnapshotPoint; preview: RewindPreview } | null =
    null;
  // /resume 恢复后的初始 token 累计（App 状态栏种子）。
  let initialTotals: TokenTotals | undefined;
  // 预算账本（T-062）：会话级累计——每轮传入同一实例，跨轮次累计请求前粗估
  // 与响应后校准；/resume 时从会话 usage 重建实际分项（粗估从零重新累计）。
  let budget = new BudgetLedger();
  // /context（T-063）：非空 = 用量面板打开。runTui 在用户敲 /context 时用
  // 「系统提示 + 工具注册表 + 投影历史 + 账本」实时组装 context_state 负载注入
  // App（模态面板），Esc 经 onContextDismiss 清空关闭。
  let contextSnapshot: ContextStateData | null = null;

  // —— 压缩（T-070 /compact）——
  // 有效压缩配置：generateDelta 缺省 = 生产模型生成器（createModelDeltaGenerator
  // 捕获 provider）；阈值缺省 = 上下文窗口的 70% 折；迟滞缺省 5 轮（压缩后 5 轮
  // 内不重复自动触发，避免跨阈值后每轮压缩）。测试可经 TuiOptions.compact 注入
  // stub generateDelta，实现离线覆盖。T-082 /model：切模型后阈值随新模型的上下文
  // 窗口重算、生成器改用新 provider（let 供重建）。
  let compactConfig: CompactOptions = {
    keepTurns: startup.keepTurns,
    thresholdTokens:
      options.compact?.thresholdTokens ?? defaultCompactionThreshold(provider),
    minTurnsBetweenCompactions:
      options.compact?.minTurnsBetweenCompactions ??
      DEFAULT_MIN_TURNS_BETWEEN_COMPACTIONS,
    generateDelta:
      options.compact?.generateDelta ?? createModelDeltaGenerator(provider),
  };
  // 持久摘要状态（跨轮传回演进 / /resume 重建）：loop 把压缩后的状态随
  // TurnResult.summaryState 返回，此处接续为下一轮的种子。
  let summaryState: SummaryState | undefined = undefined;
  // 会话级待办清单（T-110/T-111）：loop 把模型 todo_write 更新的清单随
  // TurnResult.todoState 返回，此处接续为下一轮的种子；/resume 时从会话日志
  // 重建并推合成 todo_update 信封回填 App（清单跨会话保留）。
  let todoState: TodoState | undefined = undefined;
  // —— Plan Mode（T-112）：只读研究 → 结构化计划 → 批准/修改/拒绝 ——
  // planMode：true = 工具集收窄到只读（read/grep/glob）+ 系统提示词追加计划指令；
  // planProposal：计划轮结束后解析出的结构化计划（非空 = App 显示计划面板）。
  let planMode = false;
  let planProposal: StructuredPlan | null = null;

  // 合成 notice 信封（runTui 侧提示：/resume 结果等；App 是事件流纯消费者，
  // 直接经 channel 推信封即可展示——与 core 发出的 notice 同构）。
  let syntheticSeq = 0;
  const pushNotice = (level: NoticeLevel, text: string): void => {
    syntheticSeq += 1;
    channel.push({
      v: 1 as const,
      seq: syntheticSeq,
      ts: Date.now(),
      agent: 'main',
      turn: 0,
      type: 'notice',
      data: { level, text },
    });
  };

  // T-081：指令超限截断告警（不静默）。App 从 channel 消费信封，启动期 push
  // 的信封先入队、App 挂载后按 FIFO 展示，与 core 发出的 notice 同构。
  if (instructions?.notice !== undefined) {
    pushNotice('warn', instructions.notice);
  }
  // 0.17.0 T-173：长期记忆注入超限截断告警（不静默——用户要知道哪些记忆没进
  // 上下文，最近写入优先保留）。
  if (memoryLoaded.notice !== undefined) {
    pushNotice('warn', memoryLoaded.notice);
  }
  // T-114：自定义斜杠命令中被跳过的文件（缺 name/description/正文或与内置
  // 命令同名）如实告警——用户要知道自己写的命令哪份没生效。
  if (loadedCommands.skipped.length > 0) {
    pushNotice(
      'warn',
      `自定义斜杠命令：跳过 ${loadedCommands.skipped.length} 个文件` +
        `（${loadedCommands.skipped.join('、')}）——缺 name/description/正文，或与内置命令同名`,
    );
  }
  // T-114：命令的 allowedTools 白名单里含注册表不存在的工具名时启动告警（不静默
  // 丢弃）——该名在运行时被白名单过滤掉，命令实际拿到的工具集比声明少，用户要
  // 知道自己写的哪个工具名没生效。
  const unknownToolDeclarations = customCommands.flatMap((command) => {
    if (command.allowedTools === undefined) return [];
    const unknown = command.allowedTools.filter((name) => !tools.has(name));
    return unknown.length > 0
      ? [`/${command.name} 的 allowedTools 含未注册工具：${unknown.join('、')}`]
      : [];
  });
  if (unknownToolDeclarations.length > 0) {
    pushNotice(
      'warn',
      `自定义斜杠命令工具白名单：${unknownToolDeclarations.join('；')}（这些工具名将被忽略）`,
    );
  }
  // 0.17.0 T-170：自定义 agents 中被跳过的文件（缺 name/description/正文）如实
  // 告警——用户要知道自己写的角色哪份没生效（不静默）。
  if (discoveredAgents.skipped.length > 0) {
    pushNotice(
      'warn',
      `自定义 agents：跳过 ${discoveredAgents.skipped.length} 个文件` +
        `（${discoveredAgents.skipped.join('、')}）——缺 name/description/正文`,
    );
  }
  // 0.17.0 T-170：agent 角色的 allowedTools 白名单里含注册表不存在的工具名时
  // 启动告警（不静默丢弃）——该名在派发时被白名单过滤掉，角色实际拿到的工具集
  // 比声明少（权限继承不超父，ADR 0011），用户要知道自己写的哪个工具名没生效。
  const unknownAgentToolDeclarations = discoveredAgents.agents.flatMap(
    (agent) => {
      const unknown = agent.allowedTools.filter((name) => !tools.has(name));
      return unknown.length > 0
        ? [
            `角色 ${agent.name} 的 allowedTools 含未注册工具：${unknown.join('、')}`,
          ]
        : [];
    },
  );
  if (unknownAgentToolDeclarations.length > 0) {
    pushNotice(
      'warn',
      `自定义 agents 工具白名单：${unknownAgentToolDeclarations.join('；')}（这些工具名将被忽略）`,
    );
  }
  // 偏离 C：SessionStart 本版未接线——装配时配置了 SessionStart 钩子的 notice
  // （配置合法但钩子不会执行，不静默失效；startup.ts 产出）。
  for (const notice of startup.notices ?? []) {
    pushNotice('warn', notice);
  }

  // —— MCP（0.16.0 T-163）：settings.json mcp.servers → McpManager ——
  // 后台连接全部 enabled server（握手 + tools/list + 注入工具注册表），连接
  // 完成后重建系统提示词（MCP 工具定义进「可用工具」段）。崩溃重连由 manager
  // 内部调度（指数退避），状态变化以 notice 告知用户（不静默）；/mcp 查看报告。
  const mcpManager =
    mcpServers.length > 0
      ? new McpManager({
          servers: mcpServers,
          registry: tools,
          onStatusChange: (status) => {
            if (status.state === 'connected') {
              pushNotice(
                'info',
                `MCP 服务器 ${status.name} 已连接（${status.toolCount} 个工具）`,
              );
            } else if (status.state === 'failed') {
              pushNotice(
                'warn',
                `MCP 服务器 ${status.name} 连接失败：${status.error ?? '原因未知'}`,
              );
            } else if (status.state === 'disconnected') {
              pushNotice(
                'warn',
                `MCP 服务器 ${status.name} 已断开：${status.error ?? '原因未知'}`,
              );
            }
          },
        })
      : null;
  if (mcpManager !== null) {
    void mcpManager.start().then(() => {
      // 注入完成后重建稳定前缀（MCP 工具定义随注册表进提示词）；Plan Mode 下
      // system 由计划提示词接管（MCP 工具不在只读白名单，计划模式不受影响）。
      if (mcpManager.activeToolCount > 0) {
        baseSystem = buildBaseSystem();
        if (!planMode) system = baseSystem;
        rerender(); // 状态栏权限模式 / /context 数据源随注册表更新
      }
    });
  }

  // 当前轮次的 AbortController：每轮新建，Esc 只打断当前轮；
  // 若复用同一个 controller，Esc 一次会让后续所有 turn 一进来就立刻中断。
  let currentController: AbortController | null = null;

  /** 打开会话日志：缺省新建会话；resume 时传入 sessionId 续开（seq 延续）。 */
  const openSession = (sessionId?: string): void => {
    sessionLog = new SessionLog({
      homeDir,
      cwd,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  };

  /**
   * 从会话日志重新投影完整历史与 readFiles（002 4.1「上下文是日志的投影」）。
   * 串行化：把本次投影存入 historyRefresh，下一次 submit 先等它完成，保证提交
   * 时的 messages / loggedUserCount / readFiles 与日志一致。日志读取失败（极少
   * 见）不打断会话——历史保持上一投影值。
   */
  const refreshHistory = (): void => {
    historyRefresh = (
      sessionLog === null
        ? Promise.resolve()
        : sessionStore
            .read(projectHash(cwd), sessionLog.sessionId)
            .then((read) => {
              if (read === null) {
                historyMessages = [];
                loggedUserCount = 0;
                readFiles.clear();
                for (const seed of options.readFiles ?? []) readFiles.add(seed);
                return;
              }
              historyMessages = projectMessages(read.records);
              loggedUserCount = countUserMessages(historyMessages);
              return rebuildReadFiles(read.records, cwd).then((rebuilt) => {
                readFiles.clear();
                for (const seed of options.readFiles ?? []) readFiles.add(seed);
                for (const path of rebuilt) readFiles.add(path);
              });
            })
    ).catch(() => {});
  };

  /**
   * 自动快照（T-102）：每轮修改前 / 结束后把工作树状态记入影子仓库。
   *
   * - 触碰路径模式：从会话日志收集 agent 已 write/edit 的文件，只快照这些路径
   *   （大仓库单次快照 < 1 秒的关键，002 风险表）；空集（如首轮）回落全量
   *   （尊重 .gitignore + node_modules 排除，T-101）；
   * - 无变更返回 null（不产生空 commit）；超限降级点仅记录摘要并告警；
   * - 失败不阻断任务：告警 notice 后继续（快照是旁路安全网，不是任务前提）。
   */
  const takeSnapshot = async (): Promise<void> => {
    if (!snapshotEnabled) return; // T-103：配置关闭自动快照（/rewind 手动快照仍可用）
    if (sessionLog === null) return;
    try {
      const read = await sessionStore.read(
        projectHash(cwd),
        sessionLog.sessionId,
      );
      const paths = collectTouchedPaths(read?.records ?? [], { cwd });
      const point = await snapshotStore.snapshot({
        paths,
        sessionId: sessionLog.sessionId,
      });
      if (point !== null && !point.degraded && point.id !== null) {
        // 快照标记入日志（002 4.2）：审计 / 追溯用，投影时忽略。
        await sessionLog.appendSnapshot({
          ref: point.id,
          summary: point.summary,
        });
      }
    } catch (caught) {
      pushNotice('warn', `自动快照失败：${describeError(caught)}`);
    }
  };

  const startTurn = (
    text: string,
    opts?: {
      readonly tools?: ToolRegistry;
      /** 附件引用（T-133 图片输入）：submit 的 attachments / /image 携带。 */
      readonly attachments?: readonly AttachmentRef[];
    },
  ): void => {
    if (currentController !== null) return; // 已在运行，忽略（T-041 完善排队/并入）
    // 新一轮输入开始：关闭 /context 面板（避免模态遮挡新任务；Esc 也可随时关闭）
    if (contextSnapshot !== null) {
      contextSnapshot = null;
      rerender();
    }
    // 等上一轮的历史投影完成（幂等：首轮 historyRefresh 已是 resolved），
    // 保证提交时的 messages 与 loggedUserCount 一致（续写不重复落盘历史）。
    void historyRefresh.then(async () => {
      if (currentController !== null) return; // 等待投影期间已有轮次开始
      if (sessionLog === null) openSession();
      // T-102：修改前自动快照（首轮 = 初始基线；后续轮工作树未变则返回 null）
      await takeSnapshot();
      if (currentController !== null) return; // 快照期间已有轮次开始
      const controller = new AbortController();
      currentController = controller;
      // T-131 结构化日志：注入 logger 时，本轮事件流经适配器落盘 JSONL
      // （request / tool_call / permission 三类；每轮新建适配器——模型可能
      // 经 /model 切换，取本轮生效的 provider 标识）。
      const logAdapter =
        options.structuredLog === undefined
          ? null
          : new EnvelopeLogAdapter(options.structuredLog, {
              provider: provider.id,
              model: provider.modelId,
            });
      // T-133 图片输入：提供附件时，把 user 消息构造成「文本 + 图片」的多模态
      // 消息（本地路径读为 data URL；http(s)/data URI 透传）。按当前模型能力
      // 描述（capabilities.images）决定构造多模态还是诚实降级——降级 notice
      // 推入事件流（App 展示），消息保留文本 + 明确说明，绝不假装看懂图片。
      const images = (opts?.attachments ?? []).map((ref) => ref.uri);
      let userMessage: ModelMessage;
      if (images.length > 0) {
        const built = await attachImagesToUserMessage({
          prompt: text,
          images,
          capabilities: provider.capabilities,
        });
        for (const notice of built.notices) pushNotice('warn', notice);
        userMessage = built.messages[built.messages.length - 1];
      } else {
        userMessage = { role: 'user', content: text };
      }
      const messages: ModelMessage[] = [...historyMessages, userMessage];
      void runAgentTurnStreaming(
        {
          provider,
          system,
          messages,
          // 生效工具集：显式覆盖（T-114 自定义命令的 allowedTools 白名单）优先；
          // 否则 Plan Mode 收窄到只读白名单（read/grep/glob，T-112）——写/执行
          // 工具从注册表拿掉，模型即使发出 write 调用也被管线拒绝，拒绝 = 零
          // 文件改动由只读白名单保证。退出计划模式后恢复完整工具集。
          tools:
            opts?.tools ?? (planMode ? planReadonlyRegistry(tools) : tools),
          readFiles,
          cwd,
          // 审批闸门（T-044/T-050）：注入的 gate 先按 permission 矩阵裁决
          // （allow 直通 / deny 拒绝 / ask 才发 approval_request），弹窗展示
          // ask 的请求；无人裁决时按默认拒绝（deny，与 headless 同款安全默认）。
          // 危险命令（rm -rf 等黑名单）仍由 core 强制逐次确认。
          approval: approval.gate,
          // 会话日志（T-060）：旁路记录本轮；resume 后同一会话继续追加写。
          session: sessionLog ?? undefined,
          // T-061：跳过历史里已入日志的 user 消息，只记录新增段。
          loggedUserCount,
          // 预算账本（T-062）：会话级累计，每轮沿用同一实例。
          budget,
          // T-070 /compact：跨轮传回演进状态 + 压缩配置（loop 每轮请求前做
          // 「触发 → 压缩 → 投影」；压缩事件/日志由 loop 发出）。
          summaryState,
          // T-110 TodoWrite：会话级待办清单种子（跨轮演进 / /resume 重建）。
          todoState,
          compact: compactConfig,
          // T-123 写冲突检测（0.12.1 修复）：把会话级检测器适配为 loop 的
          // onFileWrite 钩子——每次工具成功写入按 agent 上报，跨 agent 同文件
          // 写入 → loop 发 notice(warn)（主代理走主事件、子代理经 applySubagent
          // 透出），前端据此提示「改动可能互相覆盖」。
          onFileWrite: toOnFileWrite(writeConflicts),
          // T-142 钩子总线：管线 ④⑦ 挂载（deny 阻止 / 改写参数 / 观察副作用）。
          ...(hooksBus !== undefined ? { hooks: hooksBus } : {}),
          // 0.17.0 T-170 自定义 agents：角色声明 model 时按装配面重建 provider 实例
          // （与 /model 的 rebuildProvider 同口径——供应商类型 + 端点 + 环境变量）。
          ...(agentsEnabled ? { resolveModel: rebuildProvider } : {}),
          options: {
            maxTurns: startup.maxTurns,
            abortSignal: controller.signal,
            retry: options.retry,
          },
        },
        (envelope: Envelope) => {
          logAdapter?.consume(envelope);
          channel.push(envelope);
        },
      )
        .then((result) => {
          // T-070：压缩后的摘要状态随 TurnResult 演进，接续为下一轮的种子
          // （含迟滞记账 turnCount / lastCompactedTurn）。
          if (result.summaryState !== undefined) {
            summaryState = result.summaryState;
          }
          // T-110：模型更新过的待办清单随 TurnResult 演进，接续为下一轮种子。
          if (result.todoState !== undefined) {
            todoState = result.todoState;
          }
          // T-112 Plan Mode：计划轮结束后解析模型输出为结构化计划，打开计划面板
          // 等用户批准/修改/拒绝。解析失败 → 退出计划模式并发 notice（不静默）。
          if (planMode && result.text.trim().length > 0) {
            const parsed = parseStructuredPlan(result.text);
            if (parsed !== null && !isEmptyPlan(parsed)) {
              planProposal = parsed;
            } else {
              planProposal = null;
              planMode = false;
              system = baseSystem;
              pushNotice(
                'warn',
                'Plan Mode 未能解析出结构化计划（期望五段：目标/涉及文件/分步改动/验证方式/风险点）。已退出计划模式，请重试。',
              );
            }
            rerender();
          }
        })
        .catch(() => {
          // 错误以协议 error 事件呈现（core 归一为 ErrorData），App 负责展示；
          // 这里只保证不悬挂，不做二次处理。
        })
        .finally(() => {
          currentController = null;
          // T-102：轮次结束后快照（记录本轮改动后的状态，供 /rewind 还原到
          // 「改动之后」的点；无变更返回 null）。随后重新投影历史供下一次续写。
          void takeSnapshot().finally(refreshHistory);
        });
    });
  };

  /**
   * 用户提交提示词入口（T-142 UserPromptSubmit 钩子）：先过钩子——block 阻止
   * 提交（notice 告知理由），allow + additionalContext 拼到提示词之后；再走
   * startTurn。只在「用户提交」路径生效：计划批准 / 回滚 / 自定义斜杠命令等
   * 程序化构造的提示词不走钩子（它们是内部流程，不是用户提交的提示词）。
   * 无钩子时恒直通（0.13.0 及之前行为）。
   */
  const submitPrompt = (
    text: string,
    opts?: {
      readonly tools?: ToolRegistry;
      readonly attachments?: readonly AttachmentRef[];
    },
  ): void => {
    if (hooksBus === undefined) {
      startTurn(text, opts);
      return;
    }
    void (async () => {
      const outcome = await runUserPromptSubmit(hooksBus, text, {
        cwd,
        ...(sessionLog !== null ? { sessionId: sessionLog.sessionId } : {}),
      });
      if (outcome.decision === 'block') {
        pushNotice(
          'warn',
          `提交被钩子阻止${outcome.reason !== undefined ? `：${outcome.reason}` : ''}`,
        );
        return;
      }
      let effective = text;
      if (
        outcome.additionalContext !== undefined &&
        outcome.additionalContext.length > 0
      ) {
        effective = `${text}\n\n${outcome.additionalContext}`;
      }
      startTurn(effective, opts);
    })();
  };

  // —— /resume（T-061）：列会话 → 选择 → 恢复并继续 ——

  /**
   * 组装当前上下文的分项核算并推入事件流（T-063）。
   *
   * 数据源：系统提示（runTui 持有）+ 工具注册表 + 投影出的历史消息
   * （historyMessages，002 4.1「上下文是日志的投影」）+ 预算账本——与
   * loop 每轮收尾发出的 context_state 同源同构（buildContextState）。
   * 合成信封走 channel（seq 接续），既是机器可读输出（评测采集），
   * 也保证 `/context` 在任意时刻（含首轮之前）都能看到核算。
   */
  const pushContextState = (): ContextStateData => {
    const snapshot = buildContextState({
      system,
      tools,
      thread: historyMessages,
      budget,
    });
    channel.push({
      v: 1 as const,
      seq: ++syntheticSeq,
      ts: Date.now(),
      agent: 'main',
      turn: 0,
      type: 'context_state',
      data: snapshot,
    });
    return snapshot;
  };

  /** 斜杠命令分发（T-082 框架）：dispatchSlash 按命令表路由到各实现（002 3.3）。 */
  const handleSlash = (name: string, args?: string): void => {
    const handlers: SlashHandlers = {
      help: handleSlashHelp,
      model: handleSlashModel,
      compact: handleSlashCompact,
      resume: handleSlashResume,
      context: handleSlashContext,
      clear: handleSlashClear,
      rewind: () => {
        void handleSlashRewind();
      },
      snapshots: (args) => {
        void handleSlashSnapshots(args);
      },
      plan: handleSlashPlan,
      init: handleSlashInit,
      image: handleSlashImage,
      cost: () => {
        void handleSlashCost();
      },
      mcp: handleSlashMcp,
      // T-114 自定义斜杠命令：.modou/commands/*.md 注册的命令
      custom: handleCustomCommand,
    };
    dispatchSlash(
      name,
      args,
      handlers,
      (unimplemented) => {
        pushNotice(
          'info',
          `斜杠命令 /${unimplemented} 尚未实现（0.8.0 支持 ${SUPPORTED_SLASH_LIST}）`,
        );
      },
      customCommands,
    );
  };

  /** /help（T-082）：列出全部命令与用法（BUILTIN_SLASH_COMMANDS + 自定义命令）。 */
  const handleSlashHelp = (): void => {
    pushNotice('info', renderHelpText(customCommandInfos));
  };

  /**
   * /init（T-132）：分析仓库结构 → 生成 AGENTS.md 初稿。
   * 预览（整篇 draft 以 notice 展示）+ 写入；AGENTS.md 已存在时不覆盖，
   * 提示用户手动合并（绝不静默覆盖已有指令文件）。同步操作，一次完成。
   */
  const handleSlashInit = (): void => {
    const result = runInit(cwd);
    // 预览：整篇初稿进输出区（用户可滚动查看，不满意可改）
    pushNotice('info', result.draft);
    if (result.wrote) {
      pushNotice(
        'info',
        `已写入 ${result.targetPath}（基于仓库结构探测生成的初稿）。` +
          '请核对并补充后使用——探测结果是尽力而为，不是权威事实。',
      );
    } else {
      pushNotice(
        'warn',
        `AGENTS.md 已存在（${result.targetPath}），未覆盖。` +
          '请手动合并初稿内容；需要重新生成可先移走原文件再 /init。',
      );
    }
  };

  /**
   * /image（T-133）：以图片输入发起一轮——`/image <文件路径 | URL>`。
   * 图片作为多模态附件（本地路径读为 data URL；http(s)/data URI 透传），
   * 按当前模型能力描述构造多模态消息或诚实降级（notice 说明无法处理）。
   * 轮次运行中拒绝（与其它斜杠命令同惯例）。
   */
  const handleSlashImage = (args?: string): void => {
    if (currentController !== null) {
      pushNotice('warn', '任务运行中，暂不能 /image（等当前轮次结束后再试）');
      return;
    }
    const target = (args ?? '').trim();
    if (target.length === 0) {
      pushNotice(
        'info',
        '用法：/image <文件路径 | URL>——以图片输入发起一轮（如 /image screenshot.png）',
      );
      return;
    }
    startTurn(`请查看并处理这张图片：${target}`, {
      attachments: [{ uri: target }],
    });
  };

  /**
   * /cost（T-134）：成本统计。
   * 数据源是会话日志的 usage 条目：本会话合计 + 本项目全部会话按天合计，
   * 均按当前模型定价（未知模型只报 token、费用标 '?'——绝不假装知道价格）。
   * 会话日志为空 / 读取失败时以 notice 说明，不抛。
   */
  const handleSlashCost = async (): Promise<void> => {
    if (sessionLog === null) {
      pushNotice(
        'info',
        '尚无会话（先发起一轮对话后再 /cost——用量记录来自会话日志）',
      );
      return;
    }
    try {
      const project = projectHash(cwd);
      const current = await sessionStore.read(project, sessionLog.sessionId);
      const records: readonly SessionRecord[] = current?.records ?? [];
      const sessionTotals = aggregateCost(
        usageEntriesFromRecords(records),
        provider.modelId,
      );
      // 按天：遍历本项目全部会话，收集全部 usage 条目
      const allUsage: TimestampedUsage[] = [];
      const summaries = await sessionStore.list(project);
      for (const summary of summaries) {
        const read = await sessionStore.read(project, summary.sessionId);
        if (read !== null) {
          allUsage.push(...usageEntriesFromRecords(read.records));
        }
      }
      const byDay = aggregateByDay(allUsage, provider.modelId);
      pushNotice(
        'info',
        renderCostReport({
          modelId: provider.modelId,
          sessionId: sessionLog.sessionId,
          session: sessionTotals,
          byDay,
        }),
      );
    } catch (caught) {
      pushNotice('warn', `成本统计失败：${describeError(caught)}`);
    }
  };

  /**
   * /mcp（T-163）：查看 MCP 服务器连接状态。
   * 报告来自 McpManager.status()（每 server 一行：状态 / 身份 / 工具数 / 错误）；
   * 未配置服务器时明确说明（不静默）。
   */
  const handleSlashMcp = (): void => {
    if (mcpManager === null) {
      pushNotice('info', renderMcpStatus([], 0));
      return;
    }
    pushNotice(
      'info',
      renderMcpStatus(mcpManager.status(), mcpManager.activeToolCount),
    );
  };

  // —— Plan Mode（T-112）：/plan 进入 → 只读研究 → 结构化计划 → 批准/修改/拒绝 ——

  /** 构造 Plan Mode 的系统提示词（只读工具集 + 计划指令；用户显式 system 时追加）。 */
  const enterPlanModePrompt = (): string => {
    if (options.system !== undefined) {
      return `${options.system}\n\n${PLAN_MODE_INSTRUCTION}`;
    }
    return buildSystemPrompt({
      tools: planReadonlyRegistry(tools),
      extra: [instructions?.text, PLAN_MODE_INSTRUCTION]
        .filter((part) => part !== undefined && part.length > 0)
        .join('\n\n'),
    });
  };

  /**
   * /plan：进入 / 退出计划模式。
   * - 已处于计划模式 → 退出（工具集恢复）；
   * - `/plan`（无参）→ 进入计划模式，等用户描述任务；
   * - `/plan <请求>` → 进入计划模式并立即以该请求启动一轮只读研究；
   * - `/plan load <路径>` → 从 markdown 文件读回计划（手动编辑后再执行，T-113），
   *   打开计划面板评审（a 批准执行 / e 修改 / r 拒绝）。
   */
  const handleSlashPlan = (args?: string): void => {
    if (currentController !== null) {
      pushNotice('warn', '任务运行中，暂不能 /plan（等当前轮次结束后再试）');
      return;
    }
    const trimmed = (args ?? '').trim();
    const loadMatch = /^load\s+(.+)$/.exec(trimmed);
    if (loadMatch !== null) {
      void loadPlanFile(loadMatch[1].trim());
      return;
    }
    if (planMode) {
      planMode = false;
      system = baseSystem;
      planProposal = null;
      rerender();
      pushNotice('info', '已退出计划模式（工具集恢复为完整集合）。');
      return;
    }
    planMode = true;
    planProposal = null;
    system = enterPlanModePrompt();
    rerender();
    pushNotice(
      'info',
      trimmed.length > 0
        ? '已进入计划模式（只读）。正在研究现状并产出结构化计划…'
        : '已进入计划模式（只读）。请描述要规划的任务；模型将只读研究并产出结构化计划（目标/涉及文件/分步改动/验证方式/风险点）。',
    );
    if (trimmed.length > 0) startTurn(trimmed);
  };

  /**
   * 从文件读回计划并打开评审面板（T-113「手动编辑后再执行」的读回路径）。
   * 读取 / 解析失败发 notice，不进入计划模式。
   */
  const loadPlanFile = async (filePath: string): Promise<void> => {
    const plan = await loadPlanFromFile(filePath);
    if (plan === null) {
      pushNotice(
        'warn',
        `无法从 ${filePath} 读取计划（文件不存在或解析失败；期望五段 markdown 或 JSON）`,
      );
      return;
    }
    planMode = true;
    system = enterPlanModePrompt();
    planProposal = plan;
    rerender();
    pushNotice(
      'info',
      `已从 ${filePath} 加载计划（目标：${plan.goal}）。a 批准执行 / e 修改 / r 拒绝。`,
    );
  };

  /** 批准计划：切回执行模式，把计划回填为 user 消息开始实施。 */
  const approvePlan = (): void => {
    const proposal = planProposal;
    planProposal = null;
    planMode = false;
    system = baseSystem;
    rerender();
    if (proposal === null) return;
    // T-113 计划文档化：批准即落盘 markdown（.modou/plans/<时间戳>.md）+
    // 会话日志 plan 条目（/resume 后计划仍在，002 4.1 日志是唯一真相）。
    // 落盘失败不静默：catch 后发告警 notice（计划仍按批准继续执行，落盘只是文档化）。
    savePlanToFile(cwd, proposal).catch((caught) => {
      pushNotice(
        'warn',
        `计划落盘失败：${describeError(caught)}（计划仍将执行）`,
      );
    });
    void sessionLog?.appendPlan(serializeStructuredPlan(proposal));
    // 计划回填上下文（002 4.1：批准后的计划是执行的输入，入日志可重建）
    const text =
      `计划已批准，开始执行。请严格按照以下计划实施，不要擅自扩大范围：\n\n` +
      serializeStructuredPlan(proposal);
    startTurn(text);
  };

  /** 拒绝计划：切回执行模式，零文件改动（Plan Mode 只读白名单保证）。 */
  const rejectPlan = (): void => {
    planProposal = null;
    planMode = false;
    system = baseSystem;
    rerender();
    pushNotice(
      'info',
      '计划已拒绝，未做任何改动（Plan Mode 只读，工作区零文件改动）。',
    );
  };

  /** 修改计划：关闭面板、保留计划模式，回显计划 markdown 供用户编辑后重新提交。 */
  const editPlan = (): void => {
    const proposal = planProposal;
    planProposal = null;
    rerender();
    if (proposal !== null) {
      pushNotice('info', serializeStructuredPlan(proposal));
      pushNotice(
        'info',
        '计划已回显为 markdown。请复制到编辑器修改后重新提交，或直接输入修改意见（仍在计划模式，只读研究）。',
      );
    }
  };

  // —— 自定义斜杠命令（T-114）：.modou/commands/*.md 即命令 ——

  /** 按工具名过滤注册表（自定义命令的 allowedTools 白名单）。 */
  const filterToolsByName = (
    source: ToolRegistry,
    names: readonly string[],
  ): ToolRegistry => {
    const filtered = new ToolRegistry();
    for (const name of names) {
      const tool = source.find(name);
      if (tool !== undefined) filtered.register(tool);
    }
    return filtered;
  };

  /**
   * 执行自定义斜杠命令：展开 `$1` 参数占位 → 应用工具白名单（allowedTools，
   * 与 Plan Mode 白名单取交集）→ 切换默认模型（声明 model 时）→ 提交一轮。
   * 命令正文作为 user 消息注入（002 3.3：slash 是前端唯一命令入口）。
   */
  const handleCustomCommand = (
    command: CustomCommandFile,
    args?: string,
  ): void => {
    if (currentController !== null) {
      pushNotice(
        'warn',
        `任务运行中，暂不能执行 /${command.name}（等当前轮次结束后再试）`,
      );
      return;
    }
    const prompt = expandCommandPlaceholders(command.prompt, args);
    // 工具白名单：命令声明 allowedTools 时收窄（Plan Mode 下与只读白名单取
    // 交集——白名单外的工具不存在即不可用）；未声明 = 当前工具集。
    const base = planMode ? planReadonlyRegistry(tools) : tools;
    const turnTools =
      command.allowedTools !== undefined && command.allowedTools.length > 0
        ? filterToolsByName(base, command.allowedTools)
        : base;
    // 默认模型：命令声明 model 且与当前不同 → 先切换再提交（002 8.2）。
    if (
      command.model !== undefined &&
      command.model.trim().length > 0 &&
      command.model !== provider.modelId
    ) {
      void switchModel(command.model).then(() => {
        startTurn(prompt, { tools: turnTools });
      });
      return;
    }
    startTurn(prompt, { tools: turnTools });
  };

  /**
   * /context 用量视图（T-063）：
   * - 普通 `/context`：打开模态面板（分项条 + 合计 + drift），Esc 关闭；
   * - `/context --json`：把核算 JSON 打成 notice 推入输出区（机器可读，
   *   供评测采集；不回显面板）；
   * 两种形态都先把核算以 context_state 信封推入事件流。
   */
  const handleSlashContext = (args?: string): void => {
    const snapshot = pushContextState();
    if ((args ?? '').includes('json')) {
      pushNotice('info', JSON.stringify(snapshot, null, 2));
      return;
    }
    contextSnapshot = snapshot;
    rerender();
  };

  /**
   * 把压缩事件以协议 compaction 信封推入事件流（App 据此告知用户「刚压缩过」，
   * 与 loop 自动压缩发出的 compaction 事件同构）。seq 接续 syntheticSeq。
   */
  const pushCompaction = (data: CompactionData): void => {
    syntheticSeq += 1;
    channel.push({
      v: 1 as const,
      seq: syntheticSeq,
      ts: Date.now(),
      agent: 'main',
      turn: 0,
      type: 'compaction',
      data,
    });
  };

  /**
   * /compact（T-070）：手动触发一次压缩——把当前投影历史里除近 keepTurns 轮外
   * 的早期轮次折叠进摘要（增量合并，rev+1），随后 K 轮内 loop 自动压缩不再重复
   * 触发。轮次运行中拒绝（loop 持有控制权）；历史为空 / 轮次不足时提示。
   */
  const handleSlashCompact = (): void => {
    if (currentController !== null) {
      pushNotice('warn', '任务运行中，暂不能 /compact（等当前轮次结束后再试）');
      return;
    }
    void handleCompact();
  };

  /** 执行一次手动压缩（/compact 的异步体，串行化在历史投影之后）。 */
  const handleCompact = async (): Promise<void> => {
    // 等上一轮历史投影收尾（与 /resume 同款串行化），保证折叠口径与日志一致
    await historyRefresh;
    if (sessionLog === null) openSession();
    const result = await performCompact({
      historyMessages,
      summaryState,
      compact: compactConfig,
      session: sessionLog,
    });
    if (result.ok) {
      summaryState = result.summaryState;
      pushCompaction(result.outcome.event); // App 展示「已压缩」
    } else {
      pushNotice(result.reason === 'error' ? 'warn' : 'info', result.message);
    }
  };

  /**
   * /resume：列出当前项目可恢复会话，打开选择器（轮次运行中拒绝）。
   * 带 args（`/resume <sessionId>`）时按会话 ID 直接恢复，不经过选择器。
   */
  const handleSlashResume = async (sessionId?: string): Promise<void> => {
    if (currentController !== null) {
      pushNotice('warn', '任务运行中，暂不能 /resume（等当前轮次结束后再试）');
      return;
    }
    const candidates = await listSessionsForResume(
      sessionStore,
      projectHash(cwd),
    );
    if (candidates.length === 0) {
      pushNotice('info', '没有可恢复的会话（当前项目尚无会话记录）');
      return;
    }
    if (sessionId !== undefined && sessionId.length > 0) {
      const match = candidates.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (match === undefined) {
        pushNotice('warn', `未找到会话 ${sessionId}（可用 /resume 查看列表）`);
        return;
      }
      await handleResumeSelect(match.sessionId);
      return;
    }
    resumeCandidates = candidates;
    rerender();
  };

  /** /resume 选择：恢复会话并继续对话（续开同一日志文件，seq 延续）。 */
  const handleResumeSelect = async (sessionId: string): Promise<void> => {
    resumeCandidates = [];
    contextSnapshot = null; // 会话切换：用量面板数据源已变，关闭
    rerender(); // 先关选择器，防重入
    // 等上一轮的历史投影收尾，避免它在本次恢复后仍以旧会话覆盖 historyMessages
    await historyRefresh;
    const resumed = await resumeSession(
      sessionStore,
      projectHash(cwd),
      sessionId,
      { cwd },
    );
    if (resumed === null) {
      pushNotice('warn', `会话 ${sessionId} 不存在或已损坏，无法恢复`);
      return;
    }
    openSession(resumed.sessionId); // 续开同一会话：继续追加写，不新建
    historyMessages = [...resumed.messages];
    loggedUserCount = countUserMessages(historyMessages);
    readFiles.clear();
    for (const path of resumed.readFiles) readFiles.add(path);
    // T-070：/resume 重建持久摘要状态（从会话日志 compaction 条目；迟滞记账
    // turnCount / lastCompactedTurn 一并恢复）——resume 后继续增量压缩，且
    // 不因阈值仍超而立即重复压缩。
    summaryState = rebuildSummaryState(resumed.records);
    // T-111：重建待办清单（从会话日志 todo_update 条目，ADR 0010「日志是唯一
    // 真相」——清单跨会话保留），并推合成 todo_update 信封回填 App 渲染。
    todoState = rebuildTodoState(resumed.records);
    if (todoState !== undefined && todoState.items.length > 0) {
      syntheticSeq += 1;
      channel.push({
        v: 1 as const,
        seq: syntheticSeq,
        ts: Date.now(),
        agent: 'main',
        turn: 0,
        type: 'todo_update',
        data: { items: todoState.items },
      });
    }
    // T-113：/resume 后计划仍在——从会话日志 plan 条目重建并发 notice 提示
    // （计划作为结构化状态入日志，002 4.1「日志是唯一真相」）。
    const restoredPlan = rebuildStructuredPlan(resumed.records);
    if (restoredPlan !== undefined) {
      pushNotice(
        'info',
        `本会话有已批准的计划（目标：${restoredPlan.goal}）。` +
          `可输入 /plan load <路径> 重新加载评审，或继续对话。`,
      );
    }
    initialTotals = {
      inputTokens: resumed.usage.inputTokens ?? 0,
      outputTokens: resumed.usage.outputTokens ?? 0,
      cacheReadTokens: resumed.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: resumed.usage.cacheWriteTokens ?? 0,
    };
    // 预算账本（T-062）：从会话 usage 重建实际分项（粗估不持久化，从零累计；
    // 后续轮次的粗估 / 校准在新账本上接续）。
    budget = BudgetLedger.rebuild([resumed.usage]);
    // T-082 /model：resume 后模型恢复为该会话最后使用的模型（002 8.2
    // 「model_switch 条目入日志，resume 后正确」）。重建失败（环境缺失）时
    // 保持当前模型并发 notice 降级，不阻断恢复。
    const restoredModel = lastModelSwitchTo(resumed.records);
    if (restoredModel !== undefined && restoredModel !== provider.modelId) {
      try {
        provider = rebuildProvider(restoredModel);
      } catch (caught) {
        pushNotice(
          'warn',
          `会话曾使用模型 ${restoredModel}，但重建 provider 失败（${describeError(caught)}），继续使用 ${provider.modelId}`,
        );
      }
    }
    rerender();
    pushNotice(
      'info',
      `已恢复会话 ${resumed.sessionId}（${resumed.entryCount} 条记录，` +
        `in ${initialTotals.inputTokens} / out ${initialTotals.outputTokens} tokens）。` +
        `继续输入即可续写同一会话。`,
    );
  };

  /**
   * 按模型 ID 重建 provider 实例（T-082 /model 与 /resume 模型恢复共用）。
   * 装配面（供应商类型 + 端点）来自 startup.providerSpec，环境沿用 startup.env；
   * 测试可经 TuiOptions.createProvider 注入 stub 以离线覆盖（不访问外网）。
   */
  const rebuildProvider = (modelId: string): ModelProvider => {
    const create = options.createProvider ?? createProviderFromConfig;
    return create(
      {
        type: startup.providerSpec.type,
        model: modelId,
        ...(startup.providerSpec.baseURL !== undefined
          ? { baseURL: startup.providerSpec.baseURL }
          : {}),
      },
      startup.env,
    );
  };

  /**
   * /model（T-082）：切换模型（002 8.2「换 provider 实例」）。
   * - 带参数 `/model <模型ID>`：直接切换；
   * - 无参数：打开候选列表选择器（slash.ts collectModelCandidates 收集）。
   * 轮次运行中拒绝（loop 持有 provider 引用）；切换后上下文延续（historyMessages
   * 不动），压缩阈值 / 摘要生成器随新模型能力重算，model_switch 条目入日志。
   */
  const handleSlashModel = (args?: string): void => {
    if (currentController !== null) {
      pushNotice('warn', '任务运行中，暂不能 /model（等当前轮次结束后再试）');
      return;
    }
    const modelId = (args ?? '').trim();
    if (modelId.length > 0) {
      void switchModel(modelId);
      return;
    }
    modelCandidates = collectModelCandidates(provider, startup.env);
    rerender();
  };

  /**
   * 执行模型切换（/model 的异步体，串行化在历史投影之后，保证切换不打断
   * 在途投影）。成功时压缩配置随新模型能力联动（002 8.2：上下文长度 / 能力
   * 变化处理），并记 model_switch 条目入日志（/resume 重建依据）。
   */
  const switchModel = async (modelId: string): Promise<void> => {
    modelCandidates = [];
    rerender(); // 先关选择器，防重入
    const from = provider.modelId;
    if (modelId === from) {
      pushNotice('info', `已在模型 ${modelId} 上，无需切换`);
      return;
    }
    let next: ModelProvider;
    try {
      next = rebuildProvider(modelId);
    } catch (caught) {
      pushNotice(
        'error',
        `切换模型失败：${describeError(caught)}（模型未变，仍为 ${from}）`,
      );
      return;
    }
    provider = next;
    // 上下文延续：historyMessages 保持不动（002 8.2「只换 provider 实例，消息不丢」）。
    // 能力变化（002 8.2）：压缩阈值随新模型上下文窗口重算；生产摘要生成器改用
    // 新 provider（测试注入的 generateDelta / thresholdTokens 保持用户覆盖）。
    compactConfig = {
      ...compactConfig,
      thresholdTokens:
        options.compact?.thresholdTokens ??
        defaultCompactionThreshold(provider),
      generateDelta:
        options.compact?.generateDelta ?? createModelDeltaGenerator(provider),
    };
    // 切换入日志（model_switch 条目；/resume 重建正确状态，002 8.2）。
    if (sessionLog === null) openSession(); // 首轮前切换：先开日志以便记录
    await sessionLog?.appendModelSwitch(from, modelId);
    pushNotice('info', `已切换到模型 ${modelId}（原 ${from}；历史上下文延续）`);
    rerender(); // 状态栏模型名更新
  };

  /**
   * /clear（T-082）：清空当前会话上下文并开启新会话。
   *
   * 语义：重置内存中的上下文投影——历史消息 / 已读集合 / 预算账本 / 摘要状态，
   * 并开启**新的会话日志**（新 sessionId）承接后续输入。原会话日志文件完整保留
   * （日志是唯一真相，永不裁剪，002 4.1），可用 /resume 恢复查看或续写。等价
   * Claude Code 的 /clear：开始一段新对话，历史留在会话文件里。
   */
  const handleSlashClear = (): void => {
    if (currentController !== null) {
      pushNotice('warn', '任务运行中，暂不能 /clear（等当前轮次结束后再试）');
      return;
    }
    if (
      historyMessages.length === 0 &&
      (sessionLog === null || sessionLog.seq === 0)
    ) {
      pushNotice('info', '上下文已是空的，无需 /clear');
      return;
    }
    void clearSession();
  };

  /** 执行清空（/clear 的异步体，串行化在历史投影之后）。 */
  const clearSession = async (): Promise<void> => {
    // 等上一轮历史投影收尾（与 /resume 同款串行化），保证新会话从干净起点开始
    await historyRefresh;
    const oldId = sessionLog?.sessionId;
    openSession(); // 新会话日志（新 sessionId；原日志文件保留）
    historyMessages = [];
    loggedUserCount = 0;
    readFiles.clear();
    for (const seed of options.readFiles ?? []) readFiles.add(seed);
    budget = new BudgetLedger();
    summaryState = undefined;
    todoState = undefined;
    initialTotals = undefined;
    contextSnapshot = null;
    rerender();
    pushNotice(
      'info',
      `已清空上下文并开启新会话 ${sessionLog?.sessionId ?? ''}` +
        (oldId !== undefined
          ? `；原会话 ${oldId} 日志保留，可用 /resume 恢复`
          : ''),
    );
  };

  // —— /rewind（T-102）：列快照点 → 选择 → 预览差异 → 确认还原 ——

  /** /rewind：列出本项目快照点（新 → 旧），打开选择器（轮次运行中拒绝）。 */
  const handleSlashRewind = async (): Promise<void> => {
    if (currentController !== null) {
      pushNotice('warn', '任务运行中，暂不能 /rewind（等当前轮次结束后再试）');
      return;
    }
    const points = await snapshotStore.listSnapshots();
    const restorable = points.filter((point) => !point.degraded);
    if (restorable.length === 0) {
      pushNotice('info', '没有可回滚的快照点（本会话尚未产生快照）');
      return;
    }
    snapshotCandidates = restorable;
    rerender();
  };

  /** /rewind 选择：计算回滚预览，有差异进入确认态（无差异直接提示）。 */
  const handleRewindSelect = async (id: string): Promise<void> => {
    const point = snapshotStore.findSnapshot(id);
    if (point === undefined || point.degraded) {
      snapshotCandidates = [];
      rerender();
      pushNotice('warn', '该快照点不存在或未保存完整内容，无法还原');
      return;
    }
    try {
      const preview = await snapshotStore.previewRewind(id);
      if (preview.restoreFiles.length + preview.deleteFiles.length === 0) {
        snapshotCandidates = [];
        rerender();
        pushNotice('info', '该快照点与当前状态一致，无需还原');
        return;
      }
      rewindTarget = { point, preview };
      rerender();
    } catch (caught) {
      pushNotice('warn', `无法预览回滚：${describeError(caught)}`);
    }
  };

  /** /rewind 确认：执行还原，并向会话插入「已回滚到 X 点」说明（002 4.1）。 */
  const handleRewindConfirm = async (): Promise<void> => {
    const target = rewindTarget;
    rewindTarget = null;
    snapshotCandidates = [];
    rerender(); // 先关选择器，防重入
    if (target === null) return;
    try {
      const result = await snapshotStore.rewindTo(target.preview.snapshotId);
      // 还原后向会话插入显式说明：模型下次看到「已回滚」就不会重复已撤销的工作
      if (sessionLog === null) openSession();
      const short = (target.point.id ?? '').slice(0, 8);
      await sessionLog?.appendUser(
        `用户已回滚到快照点 ${short}（${target.point.summary}）。` +
          `文件已还原到该点状态，之前的改动已被撤销——请勿重复已撤销的工作。`,
      );
      refreshHistory(); // 重新投影（含回滚说明），下一次提交模型能看到
      const parts = [`已还原 ${result.restored.length} 个文件`];
      if (result.deleted.length > 0) {
        parts.push(`删除 ${result.deleted.length} 个文件`);
      }
      pushNotice('info', `${parts.join('，')}（回滚到 ${short}）`);
    } catch (caught) {
      pushNotice('error', `还原失败：${describeError(caught)}`);
    }
  };

  /** /rewind 取消 / 返回：确认态退回列表，列表态关闭。 */
  const handleSnapshotCancel = (): void => {
    if (rewindTarget !== null) {
      rewindTarget = null; // 退回列表态（选择器仍在）
    } else {
      snapshotCandidates = [];
    }
    rerender();
  };

  // —— /snapshots（T-103）：查看占用 / 清理过期快照 ——

  /** /snapshots：查看全部项目的快照占用；`--cleanup` 触发清理（按保留策略）。 */
  const handleSlashSnapshots = async (args?: string): Promise<void> => {
    if (currentController !== null) {
      pushNotice(
        'warn',
        '任务运行中，暂不能 /snapshots（等当前轮次结束后再试）',
      );
      return;
    }
    try {
      if ((args ?? '').includes('cleanup')) {
        const result = await snapshotStore.cleanup();
        pushNotice(
          'info',
          `快照清理完成：移除 ${result.removed} 条，保留 ${result.kept} 条；` +
            `释放 ${formatBytes(result.freedBytes)}（${formatBytes(result.beforeBytes)} → ${formatBytes(result.afterBytes)}）`,
        );
        return;
      }
      const usage = await snapshotStore.reportUsage();
      const lines = ['快照占用：'];
      if (usage.projects.length === 0) lines.push('（尚无快照）');
      for (const project of usage.projects) {
        const marker =
          project.projectHash === snapshotStore.projectHash
            ? '（当前项目）'
            : '';
        lines.push(
          `  ${project.projectHash}${marker}：${project.snapshotCount} 个快照` +
            `${project.degradedCount > 0 ? ` / ${project.degradedCount} 个降级` : ''} · ` +
            `${formatBytes(project.bytes)} · 最近 ${formatSnapshotTime(project.lastTs)}`,
        );
      }
      lines.push(`合计 ${formatBytes(usage.totalBytes)}`);
      pushNotice('info', lines.join('\n'));
    } catch (caught) {
      pushNotice('warn', `快照命令失败：${describeError(caught)}`);
    }
  };

  // 发 Command 通道（002 3.3 反向通道）
  const send = (command: Command): void => {
    switch (command.type) {
      case 'submit':
        // T-133 图片输入：submit 携带附件（AttachmentRef）时作为多模态输入；
        // T-142：用户提交的提示词先过 UserPromptSubmit 钩子（block 阻止 / 注入）。
        submitPrompt(command.text, {
          ...(command.attachments !== undefined
            ? { attachments: command.attachments }
            : {}),
        });
        break;
      case 'interrupt':
        currentController?.abort('用户中断');
        break;
      case 'approve':
        // T-044 审批裁决：弹窗用户选择 → resolve 对应 pending 请求（decider 继续）
        approval.resolve(command.requestId, command.decision);
        break;
      case 'slash':
        // T-082 斜杠命令框架：dispatchSlash 分发（/help /model /compact /
        // /resume /context /clear /plan；未实现发 notice）。输入框已支持 slash 发送（T-041）。
        handleSlash(command.name, command.args);
        break;
      case 'plan_approve':
        // T-112 Plan Mode：用户从计划面板批准 → 切回执行模式并按计划实施
        approvePlan();
        break;
      case 'plan_reject':
        // 拒绝 → 切回执行模式，零文件改动（只读白名单保证）
        rejectPlan();
        break;
      case 'plan_modify':
        // 修改 → 关闭面板、保留计划模式、回显计划文本供用户编辑
        editPlan();
        break;
      default:
        // steer：后续任务接线
        break;
    }
  };

  // —— App 渲染与退出 ——
  let app: Instance | null = null;
  let settled = false;
  let resolveResult: ((result: TuiResult) => void) | null = null;

  /** 用当前 /resume 状态重渲染 App（打开/关闭选择器、注入初始 totals）。 */
  const renderApp = (): ReactElement =>
    createElement(App, {
      stream: channel.stream,
      send,
      onExit: () => finish(0),
      // 状态栏（T-045）：模型名取 provider.modelId；权限模式从工具注册表推导
      // （含写/执行工具 =「写/执行需审批」，只读工具集 =「只读」，见 status.tsx）
      modelName: provider.modelId,
      permissionMode: derivePermissionMode(tools),
      // T-112 Plan Mode：计划模式指示 + 待评审计划（裁决经 Command 回传）
      planMode,
      planProposal,
      // T-114 自定义斜杠命令：输入框补全候选（内置 + 自定义）
      slashCommands: slashCompletion,
      // /resume（T-061）：非空时 App 显示会话选择器并隐藏输入行
      resumeCandidates,
      onResumeSelect: (sessionId) => {
        void handleResumeSelect(sessionId);
      },
      onResumeCancel: () => {
        resumeCandidates = [];
        rerender();
      },
      // 恢复会话后的初始 token 累计（状态栏种子）
      initialTotals,
      // /context（T-063）：非空 = 用量面板打开（模态），Esc 清空关闭
      contextState: contextSnapshot ?? undefined,
      onContextDismiss: () => {
        contextSnapshot = null;
        rerender();
      },
      // /model（T-082）：非空 = 模型选择器打开（模态），Esc 取消关闭；
      // 用户选中 → switchModel 重建 provider（上下文延续）
      modelCandidates,
      onModelSelect: (modelId) => {
        void switchModel(modelId);
      },
      onModelCancel: () => {
        modelCandidates = [];
        rerender();
      },
      // /rewind（T-102）：非空 = 快照选择器打开（模态）；选中 → 预览差异进入
      // 确认态，确认 → 还原并插入会话说明，Esc 取消/返回
      snapshotCandidates,
      rewindPreview: rewindTarget?.preview,
      onSnapshotSelect: (id) => {
        void handleRewindSelect(id);
      },
      onRewindConfirm: () => {
        void handleRewindConfirm();
      },
      onSnapshotCancel: handleSnapshotCancel,
    });

  /** 重渲染 App（app 就绪后）；未就绪时静默跳过（构造期尚未挂载）。 */
  const rerender = (): void => {
    if (app !== null) app.rerender(renderApp());
  };

  const finish = (exitCode: number): void => {
    if (settled) return;
    settled = true;
    currentController?.abort(); // 退出时打断可能仍在跑的轮次
    approval.denyAll(); // 退出收尾：未裁决的审批请求一律拒绝，防悬挂
    emitter.off('SIGINT', onSigint);
    // MCP（0.16.0 T-163）：退出时关闭全部连接（杀 MCP 子进程 / 断开 HTTP）。
    // 尽力而为——子进程在父进程退出后也会因 stdin 关闭而自行退出（MCP 规范）。
    void mcpManager?.stop();
    channel.end(); // 结束事件流，App 的 for-await 得到 done
    void app?.waitUntilExit(); // 先占住 Ink 的退出 promise（unmount 会同步 resolve 它）
    app?.unmount(); // 同步收尾：移除进程退出钩子 / resize / 恢复 console
    leaveAltScreen(options.stdout); // 还原终端画面（与进入成对，真实 TTY 才生效）
    resolveResult?.({ exitCode });
  };

  const onSigint = (): void => {
    finish(130);
  };

  // index.ts 是 .ts 文件，用 createElement 而非 JSX（等价，省去把入口改名 .tsx）
  // Claude Code 式全屏：真实终端下先进入备用屏幕（接管整屏），退出时还原
  enterAltScreen(options.stdout);
  app = render(renderApp(), {
    // Ctrl+C 由 App 的 useInput 接管（发 Command 中断 + 干净退出），
    // 不用 Ink 内建的 exitOnCtrlC（那会直接 unmount，跳过我们的收尾）。
    exitOnCtrlC: false,
    // 显式默认回落 process 流：缺省传 undefined 会覆盖 Ink 内建默认
    // （Ink 对 undefined stdout 直接崩「options.stdout.on is not a function」）
    stdout: options.stdout ?? process.stdout,
    stdin: options.stdin ?? process.stdin,
  });

  emitter.on('SIGINT', onSigint);

  if (options.prompt !== undefined) {
    // T-142：初始提示词也是用户提交的提示词——先过 UserPromptSubmit 钩子
    submitPrompt(options.prompt);
  }

  return new Promise<TuiResult>((resolve) => {
    resolveResult = resolve;
  });
}

export { App } from './app';
export type { AppProps } from './app';

/** 字节数 → 人类可读（B / KB / MB；/snapshots 占用展示）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** epoch ms → `MM-DD HH:mm`（本地时区；ts<=0 时显示占位）。 */
export function formatSnapshotTime(ts: number): string {
  if (ts <= 0) return '?';
  const date = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
export { Input } from './input';
export type { InputProps } from './input';
export { performCompact } from './compact';
export type { PerformCompactInput, PerformCompactResult } from './compact';
export { Markdown } from './markdown';
export type { MarkdownProps } from './markdown';
export { ApprovalModal, createApprovalBridge } from './approval';
export type { ApprovalModalProps, ApprovalBridge } from './approval';
export { ResumePicker } from './resume';
export type { ResumePickerProps } from './resume';
export { ModelPicker } from './model';
export type { ModelPickerProps } from './model';
export { SnapshotPicker } from './rewind';
export type { SnapshotPickerProps } from './rewind';
export { PlanPanel, formatPlanLines } from './planpanel';
export type { PlanPanelProps } from './planpanel';
export * from './slash';
export type { CreateProvider } from './startup';
export {
  ContextPanel,
  formatContextRows,
  formatContextFooter,
} from './context';
export type { ContextPanelProps } from './context';
export {
  StatusBar,
  PERMISSION_MODE_LABEL,
  ZERO_TOKEN_TOTALS,
  applyUsage,
  derivePermissionMode,
} from './status';
export type {
  StatusBarProps,
  TokenTotals,
  PermissionMode,
  PermissionToolSource,
} from './status';
export {
  ToolCallList,
  DiffView,
  reduceToolEvent,
  buildDiffLines,
  diffFromPayload,
  summarizeInput,
  summarizeEntry,
} from './tools';
export type {
  ToolCallEntry,
  ToolCallStatus,
  ToolEvent,
  DiffLine,
  DiffLineKind,
} from './tools';
export {
  TodoList,
  countStatuses,
  formatTodoBar,
  formatTodoRows,
} from './todolist';
export type { TodoListProps } from './todolist';
export { createEventChannel } from './stream';
export type { EventChannel } from './stream';
export { assembleTuiStartup } from './startup';
export type { TuiOptions, TuiStartupConfig } from './startup';
