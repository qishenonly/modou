import { createElement, type ReactElement } from 'react';
import { render, type Instance } from 'ink';
import {
  buildContextState,
  buildSystemPrompt,
  BudgetLedger,
  collectTouchedPaths,
  countUserMessages,
  createModelDeltaGenerator,
  createProviderFromConfig,
  defaultReadonlyTools,
  DEFAULT_MIN_TURNS_BETWEEN_COMPACTIONS,
  listSessionsForResume,
  loadInstructions,
  projectHash,
  projectMessages,
  rebuildReadFiles,
  rebuildSummaryState,
  rebuildTodoState,
  resumeSession,
  runAgentTurnStreaming,
  SessionLog,
  SessionStore,
  SnapshotStore,
} from '@modou/core';
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
  RewindPreview,
  SnapshotPoint,
  SummaryState,
  TodoState,
} from '@modou/core';
import { App } from './app';
import { createApprovalBridge } from './approval';
import { performCompact } from './compact';
import {
  collectModelCandidates,
  describeError,
  dispatchSlash,
  lastModelSwitchTo,
  renderHelpText,
  SUPPORTED_SLASH_LIST,
} from './slash';
import type { SlashHandlers } from './slash';
import { derivePermissionMode, type TokenTotals } from './status';
import { createEventChannel } from './stream';
import { assembleTuiStartup, type TuiOptions } from './startup';

export const version = '0.10.0';

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

export async function runTui(options: TuiOptions = {}): Promise<TuiResult> {
  // T-080 配置装配：内置默认 → ~/.modou/settings.json → <project>/.modou/settings.json
  // → MODOU_* 环境变量 → 显式选项（最高优先）；provider / permission / maxTurns /
  // keepTurns / homeDir 全部来自装配结果。
  const startup = assembleTuiStartup(options);
  // 当前 provider 实例（T-082 /model：会话中途换模型 = 换实例，002 8.2；
  // let 供切换后重建并接续）。
  let provider: ModelProvider = startup.provider;
  const tools = options.tools ?? defaultReadonlyTools();
  const cwd = startup.projectRoot;
  const homeDir = startup.homeDir;
  // T-081 指令文件加载：AGENTS.md 三级指令（全局 → 项目根 → 子目录，002 九节），
  // 渲染结果拼进系统提示词 extra（options.system 显式提供时视为用户接管提示词，
  // 不注入）；超限截断的告警文本留待 pushNotice 就绪后发出——不静默，用户要能
  // 看到自己哪份指令文件没生效。
  const instructions =
    options.system === undefined ? loadInstructions({ homeDir, cwd }) : null;
  const system =
    options.system ?? buildSystemPrompt({ tools, extra: instructions?.text });
  const readFiles = new Set(options.readFiles ?? []);
  const channel = createEventChannel();
  const emitter = options.signalEmitter ?? process;
  // T-050：权限组合来自配置装配（内置默认 workspace-write + on-request，与
  // headless 一致）；projectRoot 取 cwd；矩阵 allow/deny 由 gate 内部裁决，
  // ask 才轮到弹窗。
  const permission = startup.permission;
  // 审批桥（T-044）：TUI 的 `approve` Command → ApprovalGate decider 的裁决。
  // decider 对每个请求挂起等待用户从弹窗选择；退出时 denyAll 清空未裁决请求，
  // 防止 pending 审批悬挂导致轮次永不结束。
  const approval = createApprovalBridge(permission);

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

  const startTurn = (text: string): void => {
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
      const messages: ModelMessage[] = [
        ...historyMessages,
        { role: 'user', content: text },
      ];
      void runAgentTurnStreaming(
        {
          provider,
          system,
          messages,
          tools,
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
          options: {
            maxTurns: startup.maxTurns,
            abortSignal: controller.signal,
            retry: options.retry,
          },
        },
        (envelope: Envelope) => channel.push(envelope),
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
    };
    dispatchSlash(name, args, handlers, (unimplemented) => {
      pushNotice(
        'info',
        `斜杠命令 /${unimplemented} 尚未实现（0.8.0 支持 ${SUPPORTED_SLASH_LIST}）`,
      );
    });
  };

  /** /help（T-082）：列出全部命令与用法（BUILTIN_SLASH_COMMANDS 渲染）。 */
  const handleSlashHelp = (): void => {
    pushNotice('info', renderHelpText());
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
        startTurn(command.text);
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
        // /resume /context /clear；未实现发 notice）。输入框已支持 slash 发送（T-041）。
        handleSlash(command.name, command.args);
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
    startTurn(options.prompt);
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
