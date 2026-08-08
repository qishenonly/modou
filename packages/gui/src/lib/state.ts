/**
 * 渲染进程的状态规约（纯函数，可单元测试）。
 *
 * 与 TUI App 的 apply() 同一套事件消费逻辑，只是把「for-await 逐条 setState」
 * 换成「dispatch(action) → reduce」：协议信封是唯一输入（只读消费），用户提交
 * 是本地 action（发送 Command 前把消息展示进历史）。两个前端的状态推导必须一致。
 */
import type {
  ApprovalRequestData,
  ContextStateData,
  Envelope,
  NoticeLevel,
} from '@modou/core';
import {
  applyUsage,
  ZERO_TOKEN_TOTALS,
  type TokenTotals,
} from '../../electron/status';
import { reduceToolEvent, type ToolCallEntry } from './tools';

/** 一条对话消息（用户 / 已封存的 assistant 回复）。 */
export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** 一条提示（compaction / notice 事件）。 */
export interface NoticeEntry {
  readonly id: number;
  readonly level: NoticeLevel;
  readonly text: string;
}

/** GUI 渲染进程的完整 UI 状态。 */
export interface GuiState {
  /** 已封存的对话历史（用户消息 + 完整 assistant 回复逐轮封存）。 */
  readonly history: readonly ChatMessage[];
  /** 当前轮的流式回复缓冲（turn_end / error / 下次提交时封存进历史）。 */
  readonly streamingText: string;
  /** 当前轮 thinking 缓冲（可折叠展示；turn_end 时清空）。 */
  readonly thinking: string;
  readonly running: boolean;
  readonly turn: number;
  readonly totals: TokenTotals;
  readonly tools: readonly ToolCallEntry[];
  readonly notices: readonly NoticeEntry[];
  readonly error: string | null;
  readonly approval: ApprovalRequestData | null;
  /** 最近一次 context_state（loop 每轮收尾产出；/context 面板用 getContext 实时拉）。 */
  readonly context: ContextStateData | null;
}

/** 初始状态（会话起始）。 */
export function initialGuiState(): GuiState {
  return {
    history: [],
    streamingText: '',
    thinking: '',
    running: false,
    turn: 0,
    totals: ZERO_TOKEN_TOTALS,
    tools: [],
    notices: [],
    error: null,
    approval: null,
    context: null,
  };
}

/** 本地 action（协议信封之外的用户交互）。 */
export type GuiAction =
  | { readonly type: 'envelope'; readonly envelope: Envelope }
  | { readonly type: 'user_submit'; readonly text: string }
  | { readonly type: 'user_slash'; readonly text: string }
  | { readonly type: 'clear_thread' }
  | { readonly type: 'seed_thread'; readonly messages: readonly ChatMessage[] }
  | { readonly type: 'set_totals'; readonly totals: TokenTotals };

let noticeSeq = 0;

/** 把流式缓冲封存进历史（turn_end / error / 下次提交前调用；幂等）。 */
function sealAssistant(state: GuiState): GuiState {
  if (state.streamingText.length === 0) return state;
  return {
    ...state,
    history: [
      ...state.history,
      { role: 'assistant' as const, text: state.streamingText },
    ],
    streamingText: '',
  };
}

function appendNotice(
  state: GuiState,
  level: NoticeLevel,
  text: string,
): GuiState {
  noticeSeq += 1;
  return {
    ...state,
    notices: [...state.notices, { id: noticeSeq, level, text }],
  };
}

/** 处理一条协议信封（只读消费；switch 穷尽联合，default 不处理新类型）。 */
function applyEnvelope(state: GuiState, envelope: Envelope): GuiState {
  switch (envelope.type) {
    case 'turn_start':
      // 防御：前一轮若有残留缓冲立即封存（正常情况 turn_end 已封存）
      return {
        ...sealAssistant(state),
        running: true,
        turn: envelope.data.turn,
        thinking: '',
      };
    case 'text_delta':
      return {
        ...state,
        streamingText: state.streamingText + envelope.data.delta,
      };
    case 'thinking_delta':
      return { ...state, thinking: state.thinking + envelope.data.delta };
    case 'turn_end':
      return { ...sealAssistant(state), running: false, thinking: '' };
    case 'error':
      return {
        ...sealAssistant(state),
        running: false,
        thinking: '',
        error: envelope.data.message,
      };
    case 'usage':
      return { ...state, totals: applyUsage(state.totals, envelope.data) };
    case 'compaction':
      return appendNotice(
        state,
        'info',
        `已压缩：折叠 ${envelope.data.coveredTurns[0]}..${envelope.data.coveredTurns[1]} 轮，` +
          `${envelope.data.beforeTokens} → ${envelope.data.afterTokens} tokens`,
      );
    case 'notice':
      return appendNotice(state, envelope.data.level, envelope.data.text);
    case 'tool_call':
    case 'tool_progress':
    case 'tool_result':
      return { ...state, tools: reduceToolEvent(state.tools, envelope) };
    case 'approval_request':
      return { ...state, approval: envelope.data };
    case 'approval_resolved':
      return state.approval !== null && state.approval.id === envelope.data.id
        ? { ...state, approval: null }
        : state;
    case 'context_state':
      return { ...state, context: envelope.data };
    default:
      return state;
  }
}

/** 主规约：协议信封 + 本地用户交互。 */
export function guiReducer(state: GuiState, action: GuiAction): GuiState {
  switch (action.type) {
    case 'envelope':
      return applyEnvelope(state, action.envelope);
    case 'user_submit':
    case 'user_slash': {
      // 上一轮残留的部分回复（如被打断）先封存，再展示用户消息
      const sealed = sealAssistant(state);
      return {
        ...sealed,
        history: [...sealed.history, { role: 'user', text: action.text }],
      };
    }
    case 'clear_thread':
      return {
        ...initialGuiState(),
        notices: state.notices, // 保留提示（新会话提示等）
      };
    case 'seed_thread':
      // resume 后整体替换线程（T-061：显示是日志的投影）；清空运行状态与缓冲
      return {
        ...initialGuiState(),
        history: action.messages,
        notices: state.notices,
      };
    case 'set_totals':
      // resume / clear 后校准累计 token（预算账本在 bridge 侧重建）
      return { ...state, totals: action.totals };
    default:
      return state;
  }
}
