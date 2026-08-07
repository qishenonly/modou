import { EventEmitter } from 'node:events';
import { createElement } from 'react';
import { render } from 'ink';
import {
  buildSystemPrompt,
  createProviderFromEnv,
  defaultReadonlyTools,
  runAgentTurnStreaming,
} from '@modou/core';
import type {
  Command,
  Envelope,
  ModelProvider,
  RetryOptions,
  ToolRegistry,
} from '@modou/core';
import { App } from './app';
import { createApprovalBridge } from './approval';
import { derivePermissionMode } from './status';
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
  /** 供应商错误的退避重试参数（缺省用 core 默认值）。 */
  readonly retry?: RetryOptions;
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
 * - Command：submit 触发一轮新 turn（运行中忽略，T-041 完善排队/并入）；
 *   interrupt 打断当前轮（每轮独立 AbortController，Esc 不会污染后续 turn）；
 *   approve 由审批桥裁决（用户从弹窗选择 → resolve decider，T-044）；
 *   steer / slash 由后续任务接线；
 * - 退出：Ctrl+C 经 App.onExit 走 finish(0)；SIGINT 信号走 finish(130)。
 *   两者都先打断在跑的轮次、以 deny 清空未裁决的审批请求、移除信号监听、
 *   结束事件流、卸载 Ink，保证状态干净无悬挂。
 */
export async function runTui(options: TuiOptions = {}): Promise<TuiResult> {
  const provider = options.provider ?? createProviderFromEnv('openai-compat');
  const tools = options.tools ?? defaultReadonlyTools();
  const system = options.system ?? buildSystemPrompt({ tools });
  const readFiles = options.readFiles ?? new Set<string>();
  const cwd = options.cwd ?? process.cwd();
  const channel = createEventChannel();
  const emitter = options.signalEmitter ?? process;
  // 审批桥（T-044）：TUI 的 `approve` Command → ApprovalGate decider 的裁决。
  // decider 对每个请求挂起等待用户从弹窗选择；退出时 denyAll 清空未裁决请求，
  // 防止 pending 审批悬挂导致轮次永不结束。
  const approval = createApprovalBridge();

  // 当前轮次的 AbortController：每轮新建，Esc 只打断当前轮；
  // 若复用同一个 controller，Esc 一次会让后续所有 turn 一进来就立刻中断。
  let currentController: AbortController | null = null;

  const startTurn = (text: string): void => {
    if (currentController !== null) return; // 已在运行，忽略（T-041 完善排队/并入）
    const controller = new AbortController();
    currentController = controller;
    void runAgentTurnStreaming(
      {
        provider,
        system,
        messages: [{ role: 'user', content: text }],
        tools,
        readFiles,
        cwd,
        // 审批闸门（T-044）：write / exec 工具经审批弹窗裁决；read 不拦。
        // 默认 deny——无人裁决时一律拒绝（与 headless 同款安全默认）。
        approval: approval.gate,
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
      });
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
      default:
        // steer / slash：后续任务接线
        break;
    }
  };

  return new Promise<TuiResult>((resolve) => {
    let settled = false;

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      currentController?.abort(); // 退出时打断可能仍在跑的轮次
      approval.denyAll(); // 退出收尾：未裁决的审批请求一律拒绝，防悬挂
      emitter.off('SIGINT', onSigint);
      channel.end(); // 结束事件流，App 的 for-await 得到 done
      void app.waitUntilExit(); // 先占住 Ink 的退出 promise（unmount 会同步 resolve 它）
      app.unmount(); // 同步收尾：移除进程退出钩子 / resize / 恢复 console
      resolve({ exitCode });
    };

    const onSigint = (): void => {
      finish(130);
    };

    // index.ts 是 .ts 文件，用 createElement 而非 JSX（等价，省去把入口改名 .tsx）
    const app = render(
      createElement(App, {
        stream: channel.stream,
        send,
        onExit: () => finish(0),
        // 状态栏（T-045）：模型名取 provider.modelId；权限模式从工具注册表推导
        // （含写/执行工具 =「写/执行需审批」，只读工具集 =「只读」，见 status.tsx）
        modelName: provider.modelId,
        permissionMode: derivePermissionMode(tools),
      }),
      {
        // Ctrl+C 由 App 的 useInput 接管（发 Command 中断 + 干净退出），
        // 不用 Ink 内建的 exitOnCtrlC（那会直接 unmount，跳过我们的收尾）。
        exitOnCtrlC: false,
        stdout: options.stdout,
        stdin: options.stdin,
      },
    );

    emitter.on('SIGINT', onSigint);

    if (options.prompt !== undefined) {
      startTurn(options.prompt);
    }
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
