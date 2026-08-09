/**
 * 渲染进程的状态规约（纯函数，可单元测试）。
 *
 * 与 TUI App 的 apply() 同一套事件消费逻辑，只是把「for-await 逐条 setState」
 * 换成「dispatch(action) → reduce」：协议信封是唯一输入（只读消费），用户提交
 * 是本地 action（发送 Command 前把消息展示进历史）。
 *
 * 时间线（timeline）：消息流是**时序追加**的——用户消息、assistant 回复、以及
 * **工具调用**按发生顺序同队列渲染（Claude 式：ab 间调用的工具就显示在 ab
 * 与 c 之间，而不是堆在回复末尾）。流式缓冲（streamingText）在 turn 收尾 /
 * 工具调用 / 下次提交时封存为 assistant 条目。
 */
import type {
  ApprovalRequestData,
  ContextStateData,
  Envelope,
  NoticeLevel,
  TodoItemData,
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

/** 子代理活动摘要（0.12.0 T-122：前端按 agent 分组折叠，不污染主对话）。 */
export interface SubagentEntry {
  readonly id: string;
  readonly status: 'running' | 'done' | 'error';
  readonly toolCount: number;
  readonly text: string;
}

/** 时间线条目：用户消息 / assistant 文本段 / 工具调用（按发生顺序）。 */
export type TimelineEntry =
  | { readonly id: number; readonly kind: 'user'; readonly text: string }
  | { readonly id: number; readonly kind: 'assistant'; readonly text: string }
  | {
      readonly id: number;
      readonly kind: 'tool';
      readonly entry: ToolCallEntry;
    };

/** 一条提示（compaction / notice 事件）。 */
export interface NoticeEntry {
  readonly id: number;
  readonly level: NoticeLevel;
  readonly text: string;
}

/** GUI 渲染进程的完整 UI 状态。 */
export interface GuiState {
  /** 消息时间线（用户 + assistant 文本 + 工具调用，按发生顺序）。 */
  readonly timeline: readonly TimelineEntry[];
  /** 当前轮的流式回复缓冲（turn_end / error / 工具调用 / 下次提交时封存）。 */
  readonly streamingText: string;
  /** 当前轮 thinking 缓冲（可折叠展示；turn_end 时清空）。 */
  readonly thinking: string;
  readonly running: boolean;
  readonly turn: number;
  readonly totals: TokenTotals;
  /** 待办清单（todo_update 事件负载；T-110）。 */
  readonly todo: readonly TodoItemData[];
  /** 子代理活动摘要（agent ≠ main 的信封折叠展示；0.12.0）。 */
  readonly subagents: readonly SubagentEntry[];
  readonly notices: readonly NoticeEntry[];
  readonly error: string | null;
  readonly approval: ApprovalRequestData | null;
  /** 最近一次 context_state（loop 每轮收尾产出；/context 面板用 getContext 实时拉）。 */
  readonly context: ContextStateData | null;
}

/** 初始状态（会话起始）。 */
export function initialGuiState(): GuiState {
  return {
    timeline: [],
    streamingText: '',
    thinking: '',
    running: false,
    turn: 0,
    totals: ZERO_TOKEN_TOTALS,
    todo: [],
    subagents: [],
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
  | { readonly type: 'set_totals'; readonly totals: TokenTotals }
  | { readonly type: 'app_reset' }
  /** 重新生成：移除最后一条 assistant 回复（随后 sendCommand regenerate）。 */
  | { readonly type: 'remove_last_assistant' };

let noticeSeq = 0;
let timelineSeq = 0;

/** 把流式缓冲封存进时间线（turn_end / error / 工具调用 / 下次提交前调用；幂等）。 */
function sealAssistant(state: GuiState): GuiState {
  if (state.streamingText.length === 0) return state;
  timelineSeq += 1;
  return {
    ...state,
    timeline: [
      ...state.timeline,
      {
        id: timelineSeq,
        kind: 'assistant' as const,
        text: state.streamingText,
      },
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

/** 按 callId 更新时间线里对应的工具条目（用单个条目的工具规约）。 */
function patchTimelineTool(
  state: GuiState,
  id: string,
  event: Parameters<typeof reduceToolEvent>[1],
): GuiState {
  return {
    ...state,
    timeline: state.timeline.map((entry) =>
      entry.kind === 'tool' && entry.entry.id === id
        ? { ...entry, entry: reduceToolEvent([entry.entry], event)[0] }
        : entry,
    ),
  };
}

/** 子代理事件（0.12.0 T-122）：agent ≠ main 的信封折叠成活动摘要，不进主时间线。 */
function applySubagent(state: GuiState, envelope: Envelope): GuiState {
  const id = envelope.agent;
  const current = state.subagents.find((entry) => entry.id === id);
  const base = current ?? {
    id,
    status: 'running' as const,
    toolCount: 0,
    text: '',
  };
  const upsert = (entry: SubagentEntry): GuiState => ({
    ...state,
    subagents: [...state.subagents.filter((other) => other.id !== id), entry],
  });
  switch (envelope.type) {
    case 'turn_start':
      return upsert({ ...base, status: 'running' });
    case 'turn_end':
      return upsert({ ...base, status: 'done' });
    case 'error':
      return upsert({
        ...base,
        status: 'error',
        text: `${base.text}\n${envelope.data.message}`.slice(-2000),
      });
    case 'text_delta':
      return upsert({
        ...base,
        text: `${base.text}${envelope.data.delta}`.slice(-2000),
      });
    case 'tool_call':
      return upsert({ ...base, toolCount: base.toolCount + 1 });
    default:
      return state;
  }
}

/** 处理一条协议信封（只读消费；switch 穷尽联合，default 不处理新类型）。 */
function applyEnvelope(state: GuiState, envelope: Envelope): GuiState {
  // 子代理事件独立折叠（不进主时间线）
  if (envelope.agent !== 'main') {
    return applySubagent(state, envelope);
  }
  switch (envelope.type) {
    case 'todo_update':
      return { ...state, todo: envelope.data.items };
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
    case 'tool_call': {
      // 工具调用发生时：封存当前流式文本段，把工具条目追加进时间线（内联展示）
      const sealed = sealAssistant(state);
      timelineSeq += 1;
      return {
        ...sealed,
        timeline: [
          ...sealed.timeline,
          {
            id: timelineSeq,
            kind: 'tool',
            entry: {
              id: envelope.data.id,
              name: envelope.data.name,
              input: envelope.data.input,
              status: 'pending',
            },
          },
        ],
      };
    }
    case 'tool_progress':
      return patchTimelineTool(state, envelope.data.id, envelope);
    case 'tool_result':
      return patchTimelineTool(state, envelope.data.id, envelope);
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
      timelineSeq += 1;
      return {
        ...sealed,
        timeline: [
          ...sealed.timeline,
          { id: timelineSeq, kind: 'user', text: action.text },
        ],
      };
    }
    case 'clear_thread':
      return {
        ...initialGuiState(),
        notices: state.notices, // 保留提示（新会话提示等）
      };
    case 'seed_thread': {
      // resume 后整体替换时间线（T-061：显示是日志的投影）
      const timeline: TimelineEntry[] = [];
      for (const message of action.messages) {
        timelineSeq += 1;
        timeline.push({
          id: timelineSeq,
          kind: message.role,
          text: message.text,
        });
      }
      return {
        ...initialGuiState(),
        timeline,
        notices: state.notices,
      };
    }
    case 'set_totals':
      // resume / clear 后校准累计 token（预算账本在 bridge 侧重建）
      return { ...state, totals: action.totals };
    case 'app_reset':
      // 切换项目目录后整机重置（新 bridge 从零开始；不留旧会话/旧提示）
      return initialGuiState();
    case 'remove_last_assistant': {
      // 重新生成前移除最后一条 assistant 回复（从后往前找；无则不动）
      let index = state.timeline.length - 1;
      while (index >= 0 && state.timeline[index].kind !== 'assistant') {
        index -= 1;
      }
      if (index < 0) return state;
      return {
        ...state,
        timeline: state.timeline.slice(0, index),
      };
    }
    default:
      return state;
  }
}
