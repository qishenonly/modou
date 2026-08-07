import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { createElement, type ReactElement } from 'react';
import { render, type Instance } from 'ink';
import {
  buildSystemPrompt,
  BudgetLedger,
  countUserMessages,
  createProviderFromEnv,
  defaultPermissionConfig,
  defaultReadonlyTools,
  listSessionsForResume,
  projectHash,
  projectMessages,
  rebuildReadFiles,
  resumeSession,
  runAgentTurnStreaming,
  SessionLog,
  SessionStore,
} from '@modou/core';
import type {
  Command,
  Envelope,
  ModelMessage,
  ModelProvider,
  NoticeLevel,
  PermissionConfig,
  ResumeCandidate,
  RetryOptions,
  ToolRegistry,
} from '@modou/core';
import { App } from './app';
import { createApprovalBridge } from './approval';
import { derivePermissionMode, type TokenTotals } from './status';
import { createEventChannel } from './stream';

export const version = '0.1.0';

/**
 * runTui 选项（T-040 骨架）。
 *
 * provider / system / tools / maxTurns / cwd / readFiles / retry 与 headless 同形，
 * 由 cli 装配或测试注入；缺省值尽量对齐 headless 的安全默认。
 */
export interface TuiOptions {
  /** 装配好的模型供应商（测试注入 stub；缺省 createProviderFromEnv('openai-compat')）。 */
  readonly provider?: ModelProvider;
  /**
   * 首个提示词：提供时自动提交（等价 `modou "任务"`，但走 TUI 渲染）。
   * 缺省则进入交互模式，等用户在输入行敲回车。
   */
  readonly prompt?: string;
  /** 系统指令（缺省 buildSystemPrompt({ tools })）。 */
  readonly system?: string;
  /**
   * 工具注册表（缺省 defaultReadonlyTools()——只读安全默认）。
   * 注入写 / 执行工具后，write / exec 调用会经 ApprovalGate 发 approval_request，
   * 由审批弹窗（T-044）裁决——用户选 allow_once / allow_always / deny 后经
   * `approve` Command 回传；无人裁决时按默认拒绝（deny，与 headless 同款安全
   * 默认）。危险命令（rm -rf 等黑名单）仍由 core 强制逐次确认。
   */
  readonly tools?: ToolRegistry;
  /** 轮次上限（默认 10）。 */
  readonly maxTurns?: number;
  /** 会话级已读文件集合（Write/Edit 防盲写的种子，透传给 core）。 */
  readonly readFiles?: ReadonlySet<string>;
  /** 工作目录（缺省 process.cwd()，相对路径以此解析）。 */
  readonly cwd?: string;
  /**
   * 用户主目录：会话日志根为 `<homeDir>/.modou/sessions/<project-hash>`
   * （T-060/T-061；缺省 os.homedir()）。测试注入临时目录隔离。
   */
  readonly homeDir?: string;
  /** 供应商错误的退避重试参数（缺省用 core 默认值）。 */
  readonly retry?: RetryOptions;
  /**
   * T-050 正交权限配置（沙箱范围 × 审批策略）。缺省 = workspace-write +
   * on-request（defaultPermissionConfig，projectRoot 取 cwd）——由 on-request
   * 的保守近似等价 0.3.0「写死 write/exec 全问」；弹窗只裁决 ask 之后的请求，
   * 矩阵中的 allow / deny 由 gate 内部直接裁决（弹窗不出现）。
   */
  readonly permission?: PermissionConfig;
  /** Ink 输出流（测试注入；缺省 process.stdout）。 */
  readonly stdout?: NodeJS.WriteStream;
  /** Ink 输入流（测试注入；缺省 process.stdin）。 */
  readonly stdin?: NodeJS.ReadStream;
  /** 信号源（测试注入 EventEmitter；缺省 process）。 */
  readonly signalEmitter?: EventEmitter;
}

/** runTui 的产出。 */
export interface TuiResult {
  /**
   * 退出码：Ctrl+C 交互式退出为 0（用户主动结束 TUI，同 vim/less 惯例）；
   * 收到 SIGINT 外部信号退出为 130（POSIX 128+2，与 headless 一致）。
   */
  readonly exitCode: number;
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
  const provider = options.provider ?? createProviderFromEnv('openai-compat');
  const tools = options.tools ?? defaultReadonlyTools();
  const system = options.system ?? buildSystemPrompt({ tools });
  const readFiles = new Set(options.readFiles ?? []);
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const channel = createEventChannel();
  const emitter = options.signalEmitter ?? process;
  // T-050：缺省权限组合 workspace-write + on-request（与 headless 一致），
  // projectRoot 取 cwd；矩阵 allow/deny 由 gate 内部裁决，ask 才轮到弹窗。
  const permission = options.permission ?? defaultPermissionConfig(cwd);
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
          options: {
            maxTurns: options.maxTurns ?? 10,
            abortSignal: controller.signal,
            retry: options.retry,
          },
        },
        (envelope: Envelope) => channel.push(envelope),
      )
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

  /** 斜杠命令分发：0.6.0 只实现 /resume（002 3.3 slash；T-082 0.8.0 做框架）。 */
  const handleSlash = (name: string, args?: string): void => {
    if (name === 'resume') {
      void handleSlashResume(args);
      return;
    }
    pushNotice('info', `斜杠命令 /${name} 尚未实现（0.6.0 仅支持 /resume）`);
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
export { Markdown } from './markdown';
export type { MarkdownProps } from './markdown';
export { ApprovalModal, createApprovalBridge } from './approval';
export type { ApprovalModalProps, ApprovalBridge } from './approval';
export { ResumePicker } from './resume';
export type { ResumePickerProps } from './resume';
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
