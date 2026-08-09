/**
 * GUI 主进程桥：core 编排 + 事件流广播。
 *
 * 与 runTui（packages/tui/src/index.ts）**同一套编排逻辑**的 Electron 版，
 * 覆盖 0.10–0.17 的编排能力：
 * - 快照（0.10.0）：SnapshotStore + 每轮自动快照 + /rewind 列表/预览/还原；
 * - 清单（0.11.0）：todo_update 事件由 loop 发出（协议已有），桥只演进 todoState；
 * - Plan Mode（0.11.0）：只读白名单 → 结构化计划 → 批准/修改/拒绝（plan_* 命令）；
 * - 子代理（0.12.0）：协议零改动（Envelope.agent 从第一天就有），前端按 agent 分组；
 * - Hooks（0.14.0）：startup 装配的 HookBus 注入 loop（管线 ④⑦ 直通变为真实执行）；
 * - Skills（0.15.0）/ 自定义 agents（0.17.0）：工具注入 + 清单进系统提示词；
 * - MCP（0.16.0）：McpManager 注入工具注册表 + /mcp 状态；联网（0.17.0）经
 *   withWebTools 注册；长期记忆（0.17.0）经 withMemoryTools + 启动注入。
 *
 * 协议信封经 `emitEvent` 推给渲染进程，Command 经 `sendCommand` 进入——渲染进程
 * 是事件流纯消费者（002 3.3）；UI 模态由渲染进程驱动，本桥只提供「拉取型」查询。
 * 本文件**不 import 'electron'**：主进程 / 单元测试共用（测试注入 stub provider
 * 与回调，离线覆盖），main.ts 只负责把桥接到 Electron IPC。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  AgentToolDeps,
  AttachmentRef,
  Command,
  CompactOptions,
  CompactionData,
  ContextStateData,
  CostTotals,
  DayCostTotals,
  Envelope,
  InitResult,
  McpServerConfig,
  McpServerStatus,
  ModelMessage,
  ModelProvider,
  NoticeLevel,
  ResumeCandidate,
  RetryOptions,
  RewindPreview,
  RewindResult,
  SessionRecord,
  SkillToolDeps,
  SnapshotPoint,
  SnapshotUsageReport,
  StructuredPlan,
  SummaryState,
  TimestampedUsage,
  TodoState,
} from '@modou/core';
import {
  aggregateByDay,
  aggregateCost,
  attachImagesToUserMessage,
  BudgetLedger,
  buildContextState,
  buildSystemPrompt,
  collectTouchedPaths,
  countUserMessages,
  createAgentTool,
  createModelDeltaGenerator,
  createProviderFromConfig,
  createSkillTool,
  defaultWriteTools,
  DEFAULT_MIN_TURNS_BETWEEN_COMPACTIONS,
  discoverAgents,
  discoverSkills,
  isEmptyPlan,
  listSessionsForResume,
  loadInstructions,
  loadMemoryText,
  McpManager,
  memoryDirFor,
  parseStructuredPlan,
  PLAN_MODE_INSTRUCTION,
  planReadonlyRegistry,
  projectHash,
  projectMessages,
  rebuildReadFiles,
  rebuildSummaryState,
  resumeSession,
  runAgentTurnStreaming,
  runInit,
  serializeStructuredPlan,
  SessionLog,
  SessionStore,
  SnapshotStore,
  ToolRegistry,
  usageEntriesFromRecords,
  withMemoryTools,
  withWebTools,
} from '@modou/core';
import { createApprovalBridge, type ApprovalBridge } from './approval';
import { performCompact } from './compact';
import type {
  GuiConfigSummary,
  GuiSettings,
  GuiSettingsPatch,
  PlanPayload,
  ReadyPayload,
  SaveSettingsResult,
  ThreadMessage,
} from './ipc';
import {
  collectModelCandidates,
  describeError,
  dispatchSlash,
  lastModelSwitchTo,
  renderHelpText,
  SUPPORTED_SLASH_LIST,
  type SlashHandlers,
} from './slash';
import { derivePermissionMode, type TokenTotals } from './status';
import {
  assembleGuiStartup,
  type CreateProvider,
  type GuiBridgeOptions,
} from './startup';

export const version = '0.17.0';

/** 从 AI SDK ModelMessage 内容里取展示文本（string 或 text part 拼接）。 */
function messageText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push(part.text);
  }
  return parts.join('\n');
}

/** 桥的对外回调：main.ts 接上 Electron 的 webContents 通道。 */
export interface GuiBridgeCallbacks {
  /** 协议信封（EVENT 通道）：渲染进程的事件流。 */
  emitEvent(envelope: Envelope): void;
  /** 配置摘要（READY 通道）：启动 / 模型·会话切换后刷新。 */
  emitReady(payload: ReadyPayload): void;
  /** 计划产出（PLAN 通道）：/plan 面板开合。 */
  emitPlan(payload: PlanPayload): void;
}

export type { GuiConfigSummary } from './ipc';

/** 缺省压缩触发阈值：上下文窗口 70%（002 7.1；maxContext 缺失时 60_000）。 */
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

/** 在既有注册表上复制并追加 skill 工具（与 runTui 同款：不动调用方资产）。 */
function withSkillTool(
  registry: ToolRegistry,
  deps: SkillToolDeps,
): ToolRegistry {
  const copy = new ToolRegistry();
  for (const tool of registry.list()) copy.register(tool);
  copy.register(createSkillTool(deps));
  return copy;
}

/** 在既有注册表上复制并追加 agent 工具（与 runTui 同款）。 */
function withAgentTool(
  registry: ToolRegistry,
  deps: AgentToolDeps,
): ToolRegistry {
  const copy = new ToolRegistry();
  for (const tool of registry.list()) copy.register(tool);
  copy.register(createAgentTool(deps));
  return copy;
}

/** 复制注册表（MCP 注入用：连接后落在副本上，不修改调用方资产）。 */
function copyTools(source: ToolRegistry): ToolRegistry {
  const copy = new ToolRegistry();
  for (const tool of source.list()) copy.register(tool);
  return copy;
}

/**
 * GuiBridge：Electron 主进程里的 core 编排桥（见文件头注释）。
 *
 * 生命周期：构造（装配工具集 / 快照 / MCP / 计划状态）→ start()（发指令告警）
 * → 渲染进程挂载后消费事件流 → sendCommand 驱动轮次 → dispose()。
 */
export class GuiBridge {
  // —— 装配（T-080 配置系统 + 0.15/0.16/0.17 工具扩展）——
  private readonly startup: ReturnType<typeof assembleGuiStartup>;
  private provider: ModelProvider;
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly createProvider: CreateProvider;
  private readonly callbacks: GuiBridgeCallbacks;
  /** 完整工具注册表（GUI 面向写/执行场景：write/edit/bash/todo/task + 扩展工具）。 */
  private readonly tools: ToolRegistry;
  /** 已发现的技能（0.15.0 渐进式披露：name + description 常驻系统提示词）。 */
  private readonly skills: readonly {
    readonly name: string;
    readonly description: string;
  }[];
  /** 已发现的角色（0.17.0 T-170：.modou/agents/*.md；设置面板展示）。 */
  private readonly agents: readonly {
    readonly name: string;
    readonly description: string;
  }[];
  /** 基准系统提示词（正常执行模式；Plan Mode 进入/退出时在 system 与 base 间切换）。 */
  private baseSystem: string;
  private system: string;
  private readonly readFiles: Set<string>;
  private readonly instructionsNotice: string | undefined;
  private readonly memoryText: string | undefined;

  // —— 会话（T-060 旁路记录 / T-061 /resume）——
  private readonly sessionStore: SessionStore;
  private sessionLog: SessionLog | null = null;
  private historyMessages: readonly ModelMessage[] = [];
  private loggedUserCount = 0;
  private historyRefresh: Promise<void> = Promise.resolve();

  // —— 预算 / 压缩（T-062 / T-070）——
  private budget = new BudgetLedger();
  private summaryState: SummaryState | undefined = undefined;
  private compactConfig: CompactOptions;
  private readonly retry: RetryOptions | undefined;

  // —— 审批（T-044：渲染进程弹窗裁决）——
  private readonly approval: ApprovalBridge;

  // —— 快照（0.10.0 T-100/T-103）——
  private readonly snapshotStore: SnapshotStore;
  private readonly snapshotEnabled: boolean;

  // —— MCP（0.16.0 T-163）——
  private readonly mcpManager: McpManager | null;

  // —— 清单（0.11.0 T-110）：loop 演进后随 TurnResult 返回，接续为下一轮种子 ——
  private todoState: TodoState | undefined = undefined;

  // —— Plan Mode（0.11.0 T-112）——
  private planMode = false;
  private planProposal: StructuredPlan | null = null;

  // —— 轮次 / 事件——
  private currentController: AbortController | null = null;
  private syntheticSeq = 0;

  constructor(
    options: GuiBridgeOptions,
    callbacks: GuiBridgeCallbacks,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.callbacks = callbacks;
    this.startup = assembleGuiStartup(options, env);
    this.env = env;
    this.provider = this.startup.provider;
    this.cwd = this.startup.projectRoot;
    this.homeDir = this.startup.homeDir;
    this.createProvider = options.createProvider ?? createProviderFromConfig;

    // T-081 指令文件加载：AGENTS.md 三级指令（全局 → 项目根 → 子目录）。
    const instructions =
      options.system === undefined
        ? loadInstructions({ homeDir: this.homeDir, cwd: this.cwd })
        : null;
    this.instructionsNotice = instructions?.notice;

    // —— 工具集装配（写/执行默认 + 0.15 技能 + 0.17 角色 + 联网 + 记忆）——
    let tools = options.tools ?? defaultWriteTools();
    const discoveredSkills = discoverSkills({
      homeDir: this.homeDir,
      projectRoot: this.cwd,
    });
    const skillIndex = new Map(
      discoveredSkills.map((skill) => [skill.name, skill] as const),
    );
    const skillsEnabled = skillIndex.size > 0;
    if (skillsEnabled) {
      tools = withSkillTool(tools, {
        resolve: (name) => skillIndex.get(name),
        names: () => [...skillIndex.keys()],
      });
    }
    const discoveredAgents = discoverAgents({
      homeDir: this.homeDir,
      projectRoot: this.cwd,
    });
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
    tools = withWebTools(tools, this.startup.web);
    const memoryDir = memoryDirFor(this.cwd);
    const memoryLoaded = loadMemoryText(memoryDir);
    this.memoryText =
      memoryLoaded.text.length > 0 ? memoryLoaded.text : undefined;
    tools = withMemoryTools(tools, { dir: memoryDir });
    this.tools = tools;
    this.skills = discoveredSkills.map((skill) => ({
      name: skill.name,
      description: skill.description,
    }));
    this.agents = discoveredAgents.agents.map((agent) => ({
      name: agent.name,
      description: agent.description,
    }));

    // —— 基准系统提示词（技能/角色清单常驻；MCP 连接完成后重建）——
    const extraParts: string[] = [];
    if (instructions !== null && instructions.text.length > 0) {
      extraParts.push(instructions.text);
    }
    if (this.memoryText !== undefined) extraParts.push(this.memoryText);
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
    this.baseSystem = buildBaseSystem();
    this.system = this.baseSystem;

    this.readFiles = new Set(options.readFiles ?? []);
    this.sessionStore = new SessionStore({ homeDir: this.homeDir });
    this.approval = createApprovalBridge(this.startup.permission);
    this.retry = options.retry;

    // —— 快照（0.10.0）：T-103 保留策略 + 体积/耗时上限 ——
    const snapshotConfig = this.startup.snapshot;
    this.snapshotEnabled = snapshotConfig?.enabled ?? true;
    this.snapshotStore = new SnapshotStore({
      homeDir: this.homeDir,
      cwd: this.cwd,
      ...(snapshotConfig !== undefined
        ? {
            retention: {
              ...(snapshotConfig.maxAgeDays !== undefined
                ? {
                    maxAgeMs: snapshotConfig.maxAgeDays * 24 * 60 * 60 * 1000,
                  }
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

    // —— 压缩配置：生产模型生成器 + 上下文窗口 70% 阈值 ——
    this.compactConfig = {
      keepTurns: this.startup.keepTurns,
      thresholdTokens:
        options.compact?.thresholdTokens ??
        defaultCompactionThreshold(this.provider),
      minTurnsBetweenCompactions:
        options.compact?.minTurnsBetweenCompactions ??
        DEFAULT_MIN_TURNS_BETWEEN_COMPACTIONS,
      generateDelta:
        options.compact?.generateDelta ??
        createModelDeltaGenerator(this.provider),
    };

    // —— MCP（0.16.0）：settings.json mcp.servers → McpManager → 工具注入 ——
    const mcpServers = this.startup.mcpServers;
    this.mcpManager =
      mcpServers.length > 0
        ? new McpManager({
            servers: mcpServers as readonly McpServerConfig[],
            registry: copyTools(this.tools),
            onStatusChange: (status: McpServerStatus) => {
              if (status.state === 'connected') {
                this.pushNotice(
                  'info',
                  `MCP 服务器 ${status.name} 已连接（${status.toolCount} 个工具）`,
                );
              } else if (status.state === 'failed') {
                this.pushNotice(
                  'warn',
                  `MCP 服务器 ${status.name} 连接失败：${status.error ?? '原因未知'}`,
                );
              } else if (status.state === 'disconnected') {
                this.pushNotice(
                  'warn',
                  `MCP 服务器 ${status.name} 已断开：${status.error ?? '原因未知'}`,
                );
              }
            },
          })
        : null;
    if (this.mcpManager !== null) {
      void this.mcpManager.start().then(() => {
        if (this.mcpManager !== null && this.mcpManager.activeToolCount > 0) {
          this.baseSystem = buildBaseSystem();
          if (!this.planMode) this.system = this.baseSystem;
          this.broadcastReady();
        }
      });
    }
  }

  /** 启动：把指令截断告警等启动期 notice 推给渲染进程，返回 ReadyPayload。 */
  start(): ReadyPayload {
    if (this.instructionsNotice !== undefined) {
      this.pushNotice('warn', this.instructionsNotice);
    }
    for (const notice of this.startup.notices ?? []) {
      this.pushNotice('warn', notice);
    }
    return this.readyPayload();
  }

  // -------------------------------------------------------------------------
  // 查询面（渲染进程「拉取型」控制）
  // -------------------------------------------------------------------------

  /** 可恢复会话列表（侧栏）。 */
  async listSessions(): Promise<ResumeCandidate[]> {
    return listSessionsForResume(this.sessionStore, projectHash(this.cwd));
  }

  /** /model 候选模型 ID（模型选择器）。 */
  listModels(): readonly string[] {
    return collectModelCandidates(this.provider, this.env);
  }

  /** 已发现的技能清单（设置面板展示；0.15.0 渐进式披露的清单部分）。 */
  listSkills(): readonly {
    readonly name: string;
    readonly description: string;
  }[] {
    return this.skills;
  }

  /** 当前上下文分项核算（/context 面板；buildContextState 与 loop 同源）。 */
  getContext(): ContextStateData {
    return buildContextState({
      system: this.system,
      tools: this.tools,
      thread: this.historyMessages,
      budget: this.budget,
    });
  }

  /** 当前线程的展示消息（resume / clear 后渲染进程播种历史用）。 */
  getThread(): readonly ThreadMessage[] {
    const out: ThreadMessage[] = [];
    for (const message of this.historyMessages) {
      if (message.role === 'user' || message.role === 'assistant') {
        const text = messageText(message.content).trim();
        if (text.length > 0) {
          out.push({ role: message.role, text });
        }
      }
    }
    return out;
  }

  /** 配置摘要（设置面板）。 */
  getConfig(): GuiConfigSummary {
    const permission = this.startup.permission;
    return {
      version,
      modelName: this.provider.modelId,
      providerType: this.startup.providerSpec.type,
      permissionMode: derivePermissionMode(this.tools),
      sandbox: permission.sandbox,
      policy: permission.policy,
      cwd: this.cwd,
      homeDir: this.homeDir,
      projectName: basename(this.cwd) || this.cwd,
      maxTurns: this.startup.maxTurns,
      keepTurns: this.startup.keepTurns,
      sessionId: this.sessionLog?.sessionId ?? null,
    };
  }

  /** 删除一条会话（侧栏）。 */
  async deleteSession(sessionId: string): Promise<boolean> {
    const deleted = await this.sessionStore.delete(
      projectHash(this.cwd),
      sessionId,
    );
    if (deleted && this.sessionLog?.sessionId === sessionId) {
      this.sessionLog = null;
    }
    return deleted;
  }

  // —— 设置（设置面板表单初值 / 保存到项目 .modou/settings.json）——

  /** 可编辑设置的当前值（设置面板表单初值）。 */
  getSettings(): GuiSettings {
    const permission = this.startup.permission;
    const hooksConfig = this.startup.hooksConfig;
    const web = this.startup.web;
    const snapshot = this.startup.snapshot;
    return {
      provider: this.startup.providerSpec.type,
      model: this.provider.modelId,
      ...(this.startup.providerSpec.baseURL !== undefined
        ? { baseURL: this.startup.providerSpec.baseURL }
        : {}),
      sandbox: permission.sandbox,
      policy: permission.policy,
      maxTurns: this.startup.maxTurns,
      keepTurns: this.startup.keepTurns,
      rules: (permission.rules ?? []).map((rule) => ({
        effect: rule.effect,
        match: rule.match,
      })),
      agents: this.agents,
      hooks:
        hooksConfig === undefined
          ? []
          : Object.entries(hooksConfig).map(([point, entries]) => ({
              point,
              count: entries?.length ?? 0,
            })),
      web:
        web === undefined
          ? null
          : {
              allowedDomains: web.allowedDomains?.length ?? 0,
              deniedDomains: web.deniedDomains?.length ?? 0,
            },
      mcpServerCount: this.startup.mcpServers.length,
      snapshot:
        snapshot === undefined
          ? null
          : {
              enabled: snapshot.enabled ?? true,
              ...(snapshot.maxAgeDays !== undefined
                ? { maxAgeDays: snapshot.maxAgeDays }
                : {}),
              ...(snapshot.keepPerSession !== undefined
                ? { keepPerSession: snapshot.keepPerSession }
                : {}),
              ...(snapshot.maxPerProject !== undefined
                ? { maxPerProject: snapshot.maxPerProject }
                : {}),
            },
    };
  }

  /** 保存设置到项目 `.modou/settings.json`（合并既有，不覆盖其他键）。 */
  async saveSettings(patch: GuiSettingsPatch): Promise<SaveSettingsResult> {
    const dir = join(this.cwd, '.modou');
    const file = join(dir, 'settings.json');
    let existing: Record<string, unknown> = {};
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        if (typeof parsed === 'object' && parsed !== null) {
          existing = parsed as Record<string, unknown>;
        }
      }
    } catch (caught) {
      return {
        ok: false,
        needRestart: false,
        message: `现有 settings.json 解析失败（${describeError(caught)}），未保存`,
      };
    }
    const next: Record<string, unknown> = { ...existing };
    if (patch.provider !== undefined) next.provider = patch.provider;
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.baseURL !== undefined) next.baseURL = patch.baseURL;
    if (patch.sandbox !== undefined || patch.policy !== undefined) {
      const permission =
        typeof existing.permission === 'object' && existing.permission !== null
          ? { ...(existing.permission as Record<string, unknown>) }
          : {};
      if (patch.sandbox !== undefined) permission.sandbox = patch.sandbox;
      if (patch.policy !== undefined) permission.policy = patch.policy;
      next.permission = permission;
    }
    if (patch.maxTurns !== undefined) next.maxTurns = patch.maxTurns;
    if (patch.keepTurns !== undefined) next.keepTurns = patch.keepTurns;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    } catch (caught) {
      return {
        ok: false,
        needRestart: false,
        message: `写入 ${file} 失败：${describeError(caught)}`,
      };
    }
    // 模型改动即时切换（/model 语义，上下文延续；错误由内部 notice 呈现）
    if (patch.model !== undefined && patch.model !== this.provider.modelId) {
      await this.switchModel(patch.model);
    }
    // 权限 / 供应商 / 上下文类改动需要重建 bridge 生效（main.ts 收到 needRestart 重建）
    const needRestart =
      patch.sandbox !== undefined ||
      patch.policy !== undefined ||
      patch.provider !== undefined ||
      patch.baseURL !== undefined ||
      patch.maxTurns !== undefined ||
      patch.keepTurns !== undefined;
    return { ok: true, needRestart };
  }

  // —— 快照（0.10.0 /rewind /snapshots）——

  /** 快照点列表（新 → 旧；/rewind 面板）。 */
  async listSnapshots(): Promise<readonly SnapshotPoint[]> {
    return this.snapshotStore.listSnapshots();
  }

  /** 回滚预览（/rewind 确认态；失败返回 null 由渲染进程提示）。 */
  async previewRewind(snapshotId: string): Promise<RewindPreview | null> {
    try {
      return await this.snapshotStore.previewRewind(snapshotId);
    } catch (caught) {
      this.pushNotice('warn', `无法预览回滚：${describeError(caught)}`);
      return null;
    }
  }

  /** 执行还原到某快照点，并向会话插入「已回滚」说明（002 4.1）。 */
  async rewindTo(snapshotId: string): Promise<RewindResult | null> {
    try {
      const result = await this.snapshotStore.rewindTo(snapshotId);
      if (this.sessionLog === null) this.openSession();
      const short = (result.snapshotId ?? '').slice(0, 8);
      await this.sessionLog?.appendUser(
        `用户已回滚到快照点 ${short}。文件已还原到该点状态，之前的改动已被撤销——请勿重复已撤销的工作。`,
      );
      this.refreshHistory();
      return result;
    } catch (caught) {
      this.pushNotice('warn', `还原失败：${describeError(caught)}`);
      return null;
    }
  }

  /** 快照占用与保留报告（/snapshots）。 */
  async snapshotReport(): Promise<SnapshotUsageReport> {
    return this.snapshotStore.reportUsage();
  }

  /** 快照过期清理（/snapshots --cleanup）。 */
  async snapshotCleanup(): Promise<void> {
    try {
      const result = await this.snapshotStore.cleanup();
      this.pushNotice(
        'info',
        `快照清理完成：删除 ${result.removed} 个过期快照，释放 ${result.freedBytes} 字节`,
      );
    } catch (caught) {
      this.pushNotice('warn', `快照清理失败：${describeError(caught)}`);
    }
  }

  // —— 成本（0.13.0 /cost）——

  /** 成本统计：本会话 + 本项目全部会话按天（结构化，渲染进程展示）。 */
  async getCost(): Promise<{
    readonly session: CostTotals;
    readonly days: readonly DayCostTotals[];
  } | null> {
    if (this.sessionLog === null) return null;
    try {
      const project = projectHash(this.cwd);
      const current = await this.sessionStore.read(
        project,
        this.sessionLog.sessionId,
      );
      const records: readonly SessionRecord[] = current?.records ?? [];
      const session = aggregateCost(
        usageEntriesFromRecords(records),
        this.provider.modelId,
      );
      const allUsage: TimestampedUsage[] = [];
      const summaries = await this.sessionStore.list(project);
      for (const summary of summaries) {
        const read = await this.sessionStore.read(project, summary.sessionId);
        if (read !== null) {
          allUsage.push(...usageEntriesFromRecords(read.records));
        }
      }
      const days = aggregateByDay(allUsage, this.provider.modelId);
      return { session, days };
    } catch {
      return null;
    }
  }

  // —— MCP（0.16.0 /mcp）——

  /** MCP 服务器状态（/mcp 面板）。 */
  getMcpStatus(): readonly McpServerStatus[] {
    return this.mcpManager?.status() ?? [];
  }

  // —— /init（0.13.0 T-132）——

  /** 探测仓库并生成 AGENTS.md 初稿（/init 预览）。 */
  planInit(): InitResult | null {
    try {
      return runInit(this.cwd);
    } catch (caught) {
      this.pushNotice('warn', `/init 探测失败：${describeError(caught)}`);
      return null;
    }
  }

  /** 写入 /init 初稿（runInit 已在预览时写入；本方法仅兜底提示）。 */
  writeInit(): boolean {
    this.pushNotice(
      'info',
      'AGENTS.md 初稿已由 /init 直接写入（若提示已存在则不覆盖，请手动合并）。',
    );
    return true;
  }

  // —— Plan Mode（0.11.0 /plan）——

  /** 当前计划模式状态（/plan 面板拉取）。 */
  getPlan(): PlanPayload {
    return { plan: this.planProposal, active: this.planMode };
  }

  // -------------------------------------------------------------------------
  // 命令面（渲染进程 → core，002 3.3 反向通道 + 0.11.0 plan_*）
  // -------------------------------------------------------------------------

  /** 处理一条 Command。 */
  sendCommand(command: Command): void {
    switch (command.type) {
      case 'submit':
        this.startTurn(command.text, { attachments: command.attachments });
        break;
      case 'interrupt':
        this.currentController?.abort('用户中断');
        break;
      case 'approve':
        this.approval.resolve(command.requestId, command.decision);
        break;
      case 'slash':
        this.handleSlash(command.name, command.args);
        break;
      case 'plan_approve':
        this.approvePlan();
        break;
      case 'plan_reject':
        this.rejectPlan();
        break;
      case 'plan_modify':
        this.editPlan();
        break;
      default:
        break;
    }
  }

  /** 退出收尾：打断在跑轮次、deny 未裁决审批（防悬挂）。 */
  dispose(): void {
    this.currentController?.abort();
    this.approval.denyAll();
    void this.mcpManager?.stop();
  }

  // -------------------------------------------------------------------------
  // 事件推送（合成信封 / ReadyPayload / Plan）
  // -------------------------------------------------------------------------

  private pushNotice(level: NoticeLevel, text: string): void {
    this.syntheticSeq += 1;
    this.callbacks.emitEvent({
      v: 1 as const,
      seq: this.syntheticSeq,
      ts: Date.now(),
      agent: 'main',
      turn: 0,
      type: 'notice',
      data: { level, text },
    });
  }

  private pushCompaction(data: CompactionData): void {
    this.syntheticSeq += 1;
    this.callbacks.emitEvent({
      v: 1 as const,
      seq: this.syntheticSeq,
      ts: Date.now(),
      agent: 'main',
      turn: 0,
      type: 'compaction',
      data,
    });
  }

  private readyPayload(totals?: TokenTotals): ReadyPayload {
    return {
      modelName: this.provider.modelId,
      permissionMode: derivePermissionMode(this.tools),
      cwd: this.cwd,
      homeDir: this.homeDir,
      projectName: basename(this.cwd) || this.cwd,
      sessionId: this.sessionLog?.sessionId ?? null,
      version,
      ...(totals !== undefined ? { totals } : {}),
    };
  }

  /** 模型 / 会话状态变化后刷新渲染进程的配置摘要。 */
  private broadcastReady(totals?: TokenTotals): void {
    this.callbacks.emitReady(this.readyPayload(totals));
  }

  /** 计划面板开合（/plan 产出/批准/拒绝/修改后推送）。 */
  private broadcastPlan(): void {
    this.callbacks.emitPlan({
      plan: this.planProposal,
      active: this.planMode,
    });
  }

  // -------------------------------------------------------------------------
  // 会话（T-060 / T-061，逻辑与 runTui 一致）
  // -------------------------------------------------------------------------

  private openSession(sessionId?: string): void {
    this.sessionLog = new SessionLog({
      homeDir: this.homeDir,
      cwd: this.cwd,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }

  /** 从会话日志重新投影历史与 readFiles（002 4.1「上下文是日志的投影」）。 */
  private refreshHistory(): void {
    this.historyRefresh = (
      this.sessionLog === null
        ? Promise.resolve()
        : this.sessionStore
            .read(projectHash(this.cwd), this.sessionLog.sessionId)
            .then((read) => {
              if (read === null) {
                this.historyMessages = [];
                this.loggedUserCount = 0;
                this.readFiles.clear();
                return;
              }
              this.historyMessages = projectMessages(read.records);
              this.loggedUserCount = countUserMessages(this.historyMessages);
              return rebuildReadFiles(read.records, this.cwd).then(
                (rebuilt) => {
                  this.readFiles.clear();
                  for (const path of rebuilt) this.readFiles.add(path);
                },
              );
            })
    ).catch(() => {});
  }

  /** 修改前自动快照（0.10.0 T-102；首轮 = 初始基线，工作树未变返回 null）。 */
  private async takeSnapshot(): Promise<void> {
    if (!this.snapshotEnabled || this.sessionLog === null) return;
    try {
      const read = await this.sessionStore.read(
        projectHash(this.cwd),
        this.sessionLog.sessionId,
      );
      const paths = collectTouchedPaths(read?.records ?? [], {
        cwd: this.cwd,
      });
      const point = await this.snapshotStore.snapshot({
        paths,
        sessionId: this.sessionLog.sessionId,
      });
      if (point !== null && !point.degraded && point.id !== null) {
        await this.sessionLog.appendSnapshot({
          ref: point.id,
          summary: point.summary,
        });
      }
    } catch (caught) {
      this.pushNotice('warn', `自动快照失败：${describeError(caught)}`);
    }
  }

  /** 启动一轮（附件支持 /image；快照先行；todo/plan 结果随 TurnResult 演进）。 */
  private startTurn(
    text: string,
    opts?: { readonly attachments?: readonly AttachmentRef[] },
  ): void {
    if (this.currentController !== null) return;
    void this.historyRefresh.then(async () => {
      if (this.currentController !== null) return;
      if (this.sessionLog === null) this.openSession();
      await this.takeSnapshot();
      if (this.currentController !== null) return;
      const controller = new AbortController();
      this.currentController = controller;

      // T-133 图片输入：附件 → 多模态消息（能力不支持时诚实降级）
      const images = (opts?.attachments ?? []).map((ref) => ref.uri);
      let userMessage: ModelMessage;
      if (images.length > 0) {
        const built = await attachImagesToUserMessage({
          prompt: text,
          images,
          capabilities: this.provider.capabilities,
        });
        userMessage = built.messages[0] ?? { role: 'user', content: text };
        for (const notice of built.notices) {
          this.pushNotice('warn', notice);
        }
      } else {
        userMessage = { role: 'user', content: text };
      }

      const messages: ModelMessage[] = [...this.historyMessages, userMessage];
      void runAgentTurnStreaming(
        {
          provider: this.provider,
          system: this.system,
          messages,
          tools: this.tools,
          readFiles: this.readFiles,
          cwd: this.cwd,
          approval: this.approval.gate,
          hooks: this.startup.hooks,
          session: this.sessionLog ?? undefined,
          loggedUserCount: this.loggedUserCount,
          budget: this.budget,
          summaryState: this.summaryState,
          todoState: this.todoState,
          compact: this.compactConfig,
          options: {
            maxTurns: this.startup.maxTurns,
            abortSignal: controller.signal,
            retry: this.retry,
          },
        },
        (envelope: Envelope) => this.callbacks.emitEvent(envelope),
      )
        .then((result) => {
          if (result.summaryState !== undefined) {
            this.summaryState = result.summaryState;
          }
          if (result.todoState !== undefined) {
            this.todoState = result.todoState;
          }
          // T-112 Plan Mode：计划轮结束后解析模型输出为结构化计划，打开计划面板
          if (this.planMode && result.text.trim().length > 0) {
            const parsed = parseStructuredPlan(result.text);
            if (parsed !== null && !isEmptyPlan(parsed)) {
              this.planProposal = parsed;
            } else {
              this.planProposal = null;
              this.planMode = false;
              this.system = this.baseSystem;
              this.pushNotice(
                'warn',
                'Plan Mode 未能解析出结构化计划（期望五段：目标/涉及文件/分步改动/验证方式/风险点）。已退出计划模式，请重试。',
              );
            }
            this.broadcastPlan();
          }
        })
        .catch(() => {
          // 错误以协议 error 事件呈现（core 归一为 ErrorData），渲染进程负责展示
        })
        .finally(() => {
          this.currentController = null;
          this.refreshHistory();
        });
    });
  }

  // -------------------------------------------------------------------------
  // 斜杠命令（对齐 0.17.0 全部内置命令）
  // -------------------------------------------------------------------------

  private handleSlash(name: string, args?: string): void {
    const handlers: SlashHandlers = {
      help: () => this.pushNotice('info', renderHelpText()),
      model: (slashArgs) => this.handleSlashModel(slashArgs),
      compact: () => this.handleSlashCompact(),
      resume: (slashArgs) => {
        void this.handleSlashResume(slashArgs);
      },
      context: (slashArgs) => this.handleSlashContext(slashArgs),
      clear: () => this.handleSlashClear(),
      rewind: () => {
        void this.handleSlashRewind();
      },
      snapshots: (slashArgs) => {
        void this.handleSlashSnapshots(slashArgs);
      },
      plan: (slashArgs) => this.handleSlashPlan(slashArgs),
      init: () => {
        void this.handleSlashInit();
      },
      image: (slashArgs) => this.handleSlashImage(slashArgs),
      cost: () => {
        void this.handleSlashCost();
      },
      mcp: () => this.handleSlashMcp(),
    };
    dispatchSlash(name, args, handlers, (unimplemented) => {
      this.pushNotice(
        'info',
        `斜杠命令 /${unimplemented} 尚未实现（当前支持 ${SUPPORTED_SLASH_LIST}）`,
      );
    });
  }

  /** /context：把核算以 context_state 信封推入事件流（面板由渲染进程打开）。 */
  private handleSlashContext(args?: string): void {
    const snapshot = this.getContext();
    this.syntheticSeq += 1;
    this.callbacks.emitEvent({
      v: 1 as const,
      seq: this.syntheticSeq,
      ts: Date.now(),
      agent: 'main',
      turn: 0,
      type: 'context_state',
      data: snapshot,
    });
    if ((args ?? '').includes('json')) {
      this.pushNotice('info', JSON.stringify(snapshot, null, 2));
    }
  }

  /** /compact：手动触发一次压缩（轮次运行中拒绝）。 */
  private handleSlashCompact(): void {
    if (this.currentController !== null) {
      this.pushNotice(
        'warn',
        '任务运行中，暂不能 /compact（等当前轮次结束后再试）',
      );
      return;
    }
    void this.performCompact();
  }

  private async performCompact(): Promise<void> {
    await this.historyRefresh;
    if (this.sessionLog === null) this.openSession();
    const result = await performCompact({
      historyMessages: this.historyMessages,
      summaryState: this.summaryState,
      compact: this.compactConfig,
      session: this.sessionLog,
    });
    if (result.ok) {
      this.summaryState = result.summaryState;
      this.pushCompaction(result.outcome.event);
    } else {
      this.pushNotice(
        result.reason === 'error' ? 'warn' : 'info',
        result.message,
      );
    }
  }

  /** /resume：带会话 ID 直接恢复（无参时渲染进程打开选择器，选中后同样走这里）。 */
  private async handleSlashResume(sessionId?: string): Promise<void> {
    if (this.currentController !== null) {
      this.pushNotice(
        'warn',
        '任务运行中，暂不能 /resume（等当前轮次结束后再试）',
      );
      return;
    }
    if (sessionId === undefined || sessionId.length === 0) {
      this.pushNotice('info', '请从左侧会话列表选择要恢复的会话');
      return;
    }
    await this.historyRefresh;
    const resumed = await resumeSession(
      this.sessionStore,
      projectHash(this.cwd),
      sessionId,
      { cwd: this.cwd },
    );
    if (resumed === null) {
      this.pushNotice('warn', `会话 ${sessionId} 不存在或已损坏，无法恢复`);
      return;
    }
    this.openSession(resumed.sessionId);
    this.historyMessages = [...resumed.messages];
    this.loggedUserCount = countUserMessages(this.historyMessages);
    this.readFiles.clear();
    for (const path of resumed.readFiles) this.readFiles.add(path);
    this.summaryState = rebuildSummaryState(resumed.records);
    this.todoState = rebuiltTodoState(resumed.records);
    this.budget = BudgetLedger.rebuild([resumed.usage]);
    const restoredModel = lastModelSwitchTo(resumed.records);
    if (
      restoredModel !== undefined &&
      restoredModel !== this.provider.modelId
    ) {
      try {
        this.provider = this.rebuildProvider(restoredModel);
      } catch (caught) {
        this.pushNotice(
          'warn',
          `会话曾使用模型 ${restoredModel}，但重建 provider 失败（${describeError(caught)}），继续使用 ${this.provider.modelId}`,
        );
      }
    }
    this.broadcastReady({
      inputTokens: resumed.usage.inputTokens ?? 0,
      outputTokens: resumed.usage.outputTokens ?? 0,
      cacheReadTokens: resumed.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: resumed.usage.cacheWriteTokens ?? 0,
    });
  }

  /** /clear：清空上下文并开启新会话（原日志保留）。 */
  private handleSlashClear(): void {
    if (this.currentController !== null) {
      this.pushNotice(
        'warn',
        '任务运行中，暂不能 /clear（等当前轮次结束后再试）',
      );
      return;
    }
    void this.clearSession();
  }

  private async clearSession(): Promise<void> {
    await this.historyRefresh;
    this.openSession();
    this.historyMessages = [];
    this.loggedUserCount = 0;
    this.readFiles.clear();
    this.budget = new BudgetLedger();
    this.summaryState = undefined;
    this.todoState = undefined;
    this.broadcastReady({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  }

  /** /model：切换模型（带 ID 直接切换；无参时渲染进程打开候选列表）。 */
  private handleSlashModel(modelId?: string): void {
    if (this.currentController !== null) {
      this.pushNotice(
        'warn',
        '任务运行中，暂不能 /model（等当前轮次结束后再试）',
      );
      return;
    }
    const target = (modelId ?? '').trim();
    if (target.length === 0) {
      this.pushNotice('info', '请从设置面板或命令选择模型');
      return;
    }
    void this.switchModel(target);
  }

  private async switchModel(modelId: string): Promise<void> {
    const from = this.provider.modelId;
    if (modelId === from) {
      this.pushNotice('info', `已在模型 ${modelId} 上，无需切换`);
      return;
    }
    let next: ModelProvider;
    try {
      next = this.rebuildProvider(modelId);
    } catch (caught) {
      this.pushNotice(
        'error',
        `切换模型失败：${describeError(caught)}（模型未变，仍为 ${from}）`,
      );
      return;
    }
    this.provider = next;
    this.compactConfig = {
      ...this.compactConfig,
      thresholdTokens: defaultCompactionThreshold(this.provider),
      generateDelta: createModelDeltaGenerator(this.provider),
    };
    if (this.sessionLog === null) this.openSession();
    await this.sessionLog?.appendModelSwitch(from, modelId);
    this.broadcastReady();
  }

  // —— 0.10.0 /rewind /snapshots ——

  /** /rewind：列出快照点（渲染进程打开面板，选中后经 previewRewind/rewindTo）。 */
  private async handleSlashRewind(): Promise<void> {
    if (this.currentController !== null) {
      this.pushNotice(
        'warn',
        '任务运行中，暂不能 /rewind（等当前轮次结束后再试）',
      );
      return;
    }
    const points = await this.snapshotStore.listSnapshots();
    const restorable = points.filter((point) => !point.degraded);
    if (restorable.length === 0) {
      this.pushNotice('info', '没有可回滚的快照点（本会话尚未产生快照）');
    }
    // 渲染进程自己打开 /rewind 面板（getSnapshots 拉取），这里无需额外动作
  }

  /** /snapshots：占用报告（--cleanup 触发清理；渲染进程打开报告面板）。 */
  private async handleSlashSnapshots(args?: string): Promise<void> {
    if ((args ?? '').includes('cleanup')) {
      await this.snapshotCleanup();
      return;
    }
    this.pushNotice('info', '快照占用报告见左侧 /snapshots 面板');
  }

  // —— 0.11.0 Plan Mode ——

  /** 构造 Plan Mode 系统提示词（只读工具集 + 计划指令）。 */
  private enterPlanModePrompt(): string {
    if (this.system !== this.baseSystem) return this.system; // 显式 system 已接管
    return buildSystemPrompt({
      tools: planReadonlyRegistry(this.tools),
      extra: [this.memoryText, PLAN_MODE_INSTRUCTION]
        .filter((part) => part !== undefined && part.length > 0)
        .join('\n\n'),
    });
  }

  /** /plan：进入 / 退出计划模式；`/plan <请求>` 立即启动只读研究。 */
  private handleSlashPlan(args?: string): void {
    if (this.currentController !== null) {
      this.pushNotice(
        'warn',
        '任务运行中，暂不能 /plan（等当前轮次结束后再试）',
      );
      return;
    }
    const trimmed = (args ?? '').trim();
    if (this.planMode) {
      this.planMode = false;
      this.system = this.baseSystem;
      this.planProposal = null;
      this.broadcastPlan();
      this.pushNotice('info', '已退出计划模式（工具集恢复为完整集合）。');
      return;
    }
    this.planMode = true;
    this.planProposal = null;
    this.system = this.enterPlanModePrompt();
    this.broadcastPlan();
    this.pushNotice(
      'info',
      trimmed.length > 0
        ? '已进入计划模式（只读）。正在研究现状并产出结构化计划…'
        : '已进入计划模式（只读）。请描述要规划的任务；模型将只读研究并产出结构化计划。',
    );
    if (trimmed.length > 0) this.startTurn(trimmed);
  }

  /** 批准计划：切回执行模式，把计划回填为 user 消息开始实施。 */
  private approvePlan(): void {
    const proposal = this.planProposal;
    this.planProposal = null;
    this.planMode = false;
    this.system = this.baseSystem;
    this.broadcastPlan();
    if (proposal === null) return;
    // T-113 计划文档化：批准即落盘 markdown（失败不静默，计划仍执行）
    try {
      this.savePlanToFile(proposal);
    } catch (caught) {
      this.pushNotice(
        'warn',
        `计划落盘失败：${describeError(caught)}（计划仍将执行）`,
      );
    }
    void this.sessionLog?.appendPlan(serializeStructuredPlan(proposal));
    const text =
      `计划已批准，开始执行。请严格按照以下计划实施，不要擅自扩大范围：\n\n` +
      serializeStructuredPlan(proposal);
    this.startTurn(text);
  }

  /** 拒绝计划：切回执行模式，零文件改动（只读白名单保证）。 */
  private rejectPlan(): void {
    this.planProposal = null;
    this.planMode = false;
    this.system = this.baseSystem;
    this.broadcastPlan();
    this.pushNotice(
      'info',
      '计划已拒绝，未做任何改动（Plan Mode 只读，工作区零文件改动）。',
    );
  }

  /** 修改计划：关闭面板、保留计划模式，回显计划 markdown 供用户编辑后重新提交。 */
  private editPlan(): void {
    const proposal = this.planProposal;
    this.planProposal = null;
    this.broadcastPlan();
    if (proposal !== null) {
      this.pushNotice('info', serializeStructuredPlan(proposal));
      this.pushNotice(
        'info',
        '计划已回显为 markdown。请复制到编辑器修改后重新提交，或直接输入修改意见（仍在计划模式，只读研究）。',
      );
    }
  }

  /** 计划落盘 `.modou/plans/<时间戳>.md`（T-113 文档化）。 */
  private savePlanToFile(plan: StructuredPlan): void {
    const dir = join(this.cwd, '.modou', 'plans');
    const file = join(
      dir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}.md`,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, serializeStructuredPlan(plan), 'utf8');
  }

  // —— 0.13.0 /init /image /cost ——

  /** /init：分析仓库结构 → 生成 AGENTS.md 初稿（预览后写入；已存在不覆盖）。 */
  private handleSlashInit(): void {
    const result = this.planInit();
    if (result === null) return;
    // 初稿整篇进输出区（notice 多行）；写入结果提示
    this.pushNotice('info', result.draft);
    if (result.wrote) {
      this.pushNotice(
        'info',
        `已写入 ${result.targetPath}（基于仓库结构探测生成的初稿）。请核对并补充后使用——探测结果是尽力而为，不是权威事实。`,
      );
    } else {
      this.pushNotice(
        'warn',
        `AGENTS.md 已存在（${result.targetPath}），未覆盖。请手动合并初稿内容；需要重新生成可先移走原文件再 /init。`,
      );
    }
  }

  /** /image：以图片输入发起一轮（`/image <文件路径 | URL>`）。 */
  private handleSlashImage(args?: string): void {
    if (this.currentController !== null) {
      this.pushNotice(
        'warn',
        '任务运行中，暂不能 /image（等当前轮次结束后再试）',
      );
      return;
    }
    const target = (args ?? '').trim();
    if (target.length === 0) {
      this.pushNotice(
        'info',
        '用法：/image <文件路径 | URL>——以图片输入发起一轮（如 /image screenshot.png）',
      );
      return;
    }
    this.startTurn(`请查看并处理这张图片：${target}`, {
      attachments: [{ uri: target }],
    });
  }

  /** /cost：成本统计（渲染进程打开 /cost 面板拉取结构化数据）。 */
  private async handleSlashCost(): Promise<void> {
    if (this.sessionLog === null) {
      this.pushNotice(
        'info',
        '尚无会话（先发起一轮对话后再 /cost——用量记录来自会话日志）',
      );
      return;
    }
    const cost = await this.getCost();
    if (cost === null) return;
    this.pushNotice(
      'info',
      `成本统计已就绪（${cost.days.length} 个活跃日）——见 /cost 面板。`,
    );
  }

  /** /mcp：查看 MCP 服务器连接状态（渲染进程打开 /mcp 面板拉取）。 */
  private handleSlashMcp(): void {
    if (this.mcpManager === null) {
      this.pushNotice(
        'info',
        '未配置 MCP 服务器（settings.json 的 mcp.servers 键）',
      );
    }
  }

  private rebuildProvider(modelId: string): ModelProvider {
    return this.createProvider(
      {
        type: this.startup.providerSpec.type,
        model: modelId,
        ...(this.startup.providerSpec.baseURL !== undefined
          ? { baseURL: this.startup.providerSpec.baseURL }
          : {}),
      },
      this.env,
    );
  }
}

/** 从会话日志重建 todo 状态（T-110 /resume：todo_update 条目）。 */
function rebuiltTodoState(
  records: readonly SessionRecord[],
): TodoState | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.kind === 'todo_update') {
      return { items: record.data.items };
    }
  }
  return undefined;
}
