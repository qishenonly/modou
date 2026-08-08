/**
 * GUI 主进程桥：core 编排 + 事件流广播。
 *
 * 与 runTui（packages/tui/src/index.ts）**同一套编排逻辑**的 Electron 版：
 * - 消费同一个 core 公开 API（runAgentTurnStreaming / SessionStore / SessionLog /
 *   BudgetLedger / buildContextState / resumeSession / rebuildSummaryState …），
 *   core 零改动——GUI 与 TUI 是 core 的两个平级前端（002 2.1）；
 * - 协议信封经 `emitEvent` 推给渲染进程（main.ts 接到 webContents.send），
 *   Command 经 `sendCommand` 进入——渲染进程是事件流**纯消费者**（002 3.3）；
 * - UI 模态（模型选择 / 会话选择 / 设置 / 上下文面板）由渲染进程驱动：本桥只
 *   提供「拉取型」查询（listModels / listSessions / getContext / getConfig），
 *   不持有 UI 状态——分工与 TUI 的「runTui 注入 App prop」一致，只是传输不同。
 *
 * 本文件**不 import 'electron'**：主进程 / 单元测试共用（测试注入 stub provider
 * 与回调，离线覆盖），main.ts 只负责把桥接到 Electron IPC。
 */
import { basename } from 'node:path';
import type {
  Command,
  CompactOptions,
  CompactionData,
  ContextStateData,
  Envelope,
  ModelMessage,
  ModelProvider,
  NoticeLevel,
  ResumeCandidate,
  RetryOptions,
  SummaryState,
  ToolRegistry,
} from '@modou/core';
import {
  BudgetLedger,
  buildContextState,
  buildSystemPrompt,
  countUserMessages,
  createModelDeltaGenerator,
  createProviderFromConfig,
  defaultWriteTools,
  DEFAULT_MIN_TURNS_BETWEEN_COMPACTIONS,
  listSessionsForResume,
  loadInstructions,
  projectHash,
  projectMessages,
  rebuildReadFiles,
  rebuildSummaryState,
  resumeSession,
  runAgentTurnStreaming,
  SessionLog,
  SessionStore,
} from '@modou/core';
import { createApprovalBridge, type ApprovalBridge } from './approval';
import { performCompact } from './compact';
import type { GuiConfigSummary, ReadyPayload, ThreadMessage } from './ipc';
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

export const version = '0.9.0';

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

/**
 * GuiBridge：Electron 主进程里的 core 编排桥（见文件头注释）。
 *
 * 生命周期：构造 → start()（装配 + 发指令告警）→ 渲染进程挂载后消费事件流
 * → sendCommand 驱动轮次 → dispose()（打断在跑轮次、deny 未裁决审批）。
 */
export class GuiBridge {
  // —— 装配（T-080 配置系统：内置默认 → 全局 → 项目 → 环境变量 → 显式选项）——
  private readonly startup: ReturnType<typeof assembleGuiStartup>;
  private provider: ModelProvider;
  private readonly tools: ToolRegistry;
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly system: string;
  private readonly readFiles: Set<string>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly createProvider: CreateProvider;
  private readonly callbacks: GuiBridgeCallbacks;

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
    this.tools = options.tools ?? defaultWriteTools();
    this.cwd = this.startup.projectRoot;
    this.homeDir = this.startup.homeDir;
    this.createProvider = options.createProvider ?? createProviderFromConfig;

    // T-081 指令文件加载：AGENTS.md 三级指令（全局 → 项目根 → 子目录）。
    // 超限截断的告警不静默——start() 里发 notice。
    const instructions =
      options.system === undefined
        ? loadInstructions({ homeDir: this.homeDir, cwd: this.cwd })
        : null;
    this.system =
      options.system ??
      buildSystemPrompt({ tools: this.tools, extra: instructions?.text });
    this.instructionsNotice = instructions?.notice;

    this.readFiles = new Set(options.readFiles ?? []);
    this.sessionStore = new SessionStore({ homeDir: this.homeDir });
    this.approval = createApprovalBridge(this.startup.permission);
    this.retry = options.retry;

    // 压缩配置：生产模型生成器 + 上下文窗口 70% 阈值；测试可经 options.compact 覆盖
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
  }

  private readonly instructionsNotice: string | undefined;

  /** 启动：把指令截断告警等启动期 notice 推给渲染进程，返回 ReadyPayload。 */
  start(): ReadyPayload {
    if (this.instructionsNotice !== undefined) {
      this.pushNotice('warn', this.instructionsNotice);
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

  /** 当前上下文分项核算（/context 面板；buildContextState 与 loop 同源）。 */
  getContext(): ContextStateData {
    return buildContextState({
      system: this.system,
      tools: this.tools,
      thread: this.historyMessages,
      budget: this.budget,
    });
  }

  /** 当前线程的展示消息（resume / clear 后渲染进程播种历史用；T-061 显示是投影）。 */
  getThread(): readonly ThreadMessage[] {
    const out: ThreadMessage[] = [];
    for (const message of this.historyMessages) {
      if (message.role === 'user' || message.role === 'assistant') {
        const text = messageText(message.content).trim();
        if (text.length > 0) {
          out.push({ role: message.role, text });
        }
      }
      // tool 消息不展示为气泡（工具卡片由事件流重建）
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

  /** 删除一条会话（侧栏；成功后清空当前会话引用，防悬空）。 */
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

  // -------------------------------------------------------------------------
  // 命令面（渲染进程 → core，002 3.3 反向通道）
  // -------------------------------------------------------------------------

  /** 处理一条 Command（与 runTui 的 send 同构）。 */
  sendCommand(command: Command): void {
    switch (command.type) {
      case 'submit':
        this.startTurn(command.text);
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
      default:
        // steer：后续任务接线（与 runTui 一致）
        break;
    }
  }

  /** 退出收尾：打断在跑轮次、deny 未裁决审批（防悬挂）。 */
  dispose(): void {
    this.currentController?.abort();
    this.approval.denyAll();
  }

  // -------------------------------------------------------------------------
  // 事件推送（合成信封 / ReadyPayload）
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

  /** 启动一轮（与 runTui startTurn 同构：历史投影串行化 + 独立 AbortController）。 */
  private startTurn(text: string): void {
    if (this.currentController !== null) return; // 已在运行，忽略
    void this.historyRefresh.then(() => {
      if (this.currentController !== null) return;
      if (this.sessionLog === null) this.openSession();
      const controller = new AbortController();
      this.currentController = controller;
      const messages: ModelMessage[] = [
        ...this.historyMessages,
        { role: 'user', content: text },
      ];
      void runAgentTurnStreaming(
        {
          provider: this.provider,
          system: this.system,
          messages,
          tools: this.tools,
          readFiles: this.readFiles,
          cwd: this.cwd,
          approval: this.approval.gate,
          session: this.sessionLog ?? undefined,
          loggedUserCount: this.loggedUserCount,
          budget: this.budget,
          summaryState: this.summaryState,
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
  // 斜杠命令（T-082 框架；UI 模态在渲染进程，带参/副作用命令走这里）
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
    };
    dispatchSlash(name, args, handlers, (unimplemented) => {
      this.pushNotice(
        'info',
        `斜杠命令 /${unimplemented} 尚未实现（当前支持 ${SUPPORTED_SLASH_LIST}）`,
      );
    });
  }

  /** /context：把核算以 context_state 信封推入事件流（面板由渲染进程 getContext 打开）。 */
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

  /** 执行一次手动压缩（/compact 异步体，串行化在历史投影之后）。 */
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
    // 恢复成功不推 notice：会话切换由 READY（sessionId）驱动侧栏高亮与线程播种，
    // 对话流不刷系统消息（Claude Desktop 惯例）。
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
    this.broadcastReady({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // 清空成功不推 notice：新会话由 READY（sessionId/totals）驱动，侧栏高亮随之刷新
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

  /** 执行模型切换（/model 异步体，上下文延续，model_switch 入日志）。 */
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
    // 压缩配置随新模型能力联动（002 8.2：上下文长度 / 能力变化）
    this.compactConfig = {
      ...this.compactConfig,
      thresholdTokens: defaultCompactionThreshold(this.provider),
      generateDelta: createModelDeltaGenerator(this.provider),
    };
    if (this.sessionLog === null) this.openSession();
    await this.sessionLog?.appendModelSwitch(from, modelId);
    this.broadcastReady();
    // 切换成功不推 notice：状态栏模型名随 READY 刷新（对话流不刷系统消息）
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
