import { createElement, type ReactElement } from 'react';
import { render, type Instance } from 'ink';
import {
  buildContextState,
  buildSystemPrompt,
  BudgetLedger,
  countUserMessages,
  createModelDeltaGenerator,
  defaultReadonlyTools,
  DEFAULT_MIN_TURNS_BETWEEN_COMPACTIONS,
  listSessionsForResume,
  projectHash,
  projectMessages,
  rebuildReadFiles,
  rebuildSummaryState,
  resumeSession,
  runAgentTurnStreaming,
  SessionLog,
  SessionStore,
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
  SummaryState,
} from '@modou/core';
import { App } from './app';
import { createApprovalBridge } from './approval';
import { performCompact } from './compact';
import { derivePermissionMode, type TokenTotals } from './status';
import { createEventChannel } from './stream';
import { assembleTuiStartup, type TuiOptions } from './startup';

export const version = '0.1.0';

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
export async function runTui(options: TuiOptions = {}): Promise<TuiResult> {
  // T-080 配置装配：内置默认 → ~/.modou/settings.json → <project>/.modou/settings.json
  // → MODOU_* 环境变量 → 显式选项（最高优先）；provider / permission / maxTurns /
  // keepTurns / homeDir 全部来自装配结果。
  const startup = assembleTuiStartup(options);
  const provider = startup.provider;
  const tools = options.tools ?? defaultReadonlyTools();
  const system = options.system ?? buildSystemPrompt({ tools });
  const readFiles = new Set(options.readFiles ?? []);
  const cwd = startup.projectRoot;
  const homeDir = startup.homeDir;
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
  // stub generateDelta，实现离线覆盖。
  const compactConfig: CompactOptions = {
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

  const startTurn = (text: string): void => {
    if (currentController !== null) return; // 已在运行，忽略（T-041 完善排队/并入）
    // 新一轮输入开始：关闭 /context 面板（避免模态遮挡新任务；Esc 也可随时关闭）
    if (contextSnapshot !== null) {
      contextSnapshot = null;
      rerender();
    }
    // 等上一轮的历史投影完成（幂等：首轮 historyRefresh 已是 resolved），
    // 保证提交时的 messages 与 loggedUserCount 一致（续写不重复落盘历史）。
    void historyRefresh.then(() => {
      if (currentController !== null) return; // 等待投影期间已有轮次开始
      if (sessionLog === null) openSession();
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
        })
        .catch(() => {
          // 错误以协议 error 事件呈现（core 归一为 ErrorData），App 负责展示；
          // 这里只保证不悬挂，不做二次处理。
        })
        .finally(() => {
          currentController = null;
          refreshHistory(); // 本轮结束后重新投影历史，供下一次续写
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

  /** 斜杠命令分发：0.6.0 实现 /resume 与 /context（T-063）；0.7.0 增加 /compact（T-070）。 */
  const handleSlash = (name: string, args?: string): void => {
    if (name === 'resume') {
      void handleSlashResume(args);
      return;
    }
    if (name === 'context') {
      handleSlashContext(args);
      return;
    }
    if (name === 'compact') {
      handleSlashCompact();
      return;
    }
    pushNotice(
      'info',
      `斜杠命令 /${name} 尚未实现（0.7.0 支持 /compact、/resume 与 /context）`,
    );
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
    initialTotals = {
      inputTokens: resumed.usage.inputTokens ?? 0,
      outputTokens: resumed.usage.outputTokens ?? 0,
      cacheReadTokens: resumed.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: resumed.usage.cacheWriteTokens ?? 0,
    };
    // 预算账本（T-062）：从会话 usage 重建实际分项（粗估不持久化，从零累计；
    // 后续轮次的粗估 / 校准在新账本上接续）。
    budget = BudgetLedger.rebuild([resumed.usage]);
    rerender();
    pushNotice(
      'info',
      `已恢复会话 ${resumed.sessionId}（${resumed.entryCount} 条记录，` +
        `in ${initialTotals.inputTokens} / out ${initialTotals.outputTokens} tokens）。` +
        `继续输入即可续写同一会话。`,
    );
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
        // T-061 /resume：斜杠命令（输入框已支持 slash 发送，T-041）
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
    resolveResult?.({ exitCode });
  };

  const onSigint = (): void => {
    finish(130);
  };

  // index.ts 是 .ts 文件，用 createElement 而非 JSX（等价，省去把入口改名 .tsx）
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
export { createEventChannel } from './stream';
export type { EventChannel } from './stream';
export { assembleTuiStartup } from './startup';
export type { TuiOptions, TuiStartupConfig } from './startup';
