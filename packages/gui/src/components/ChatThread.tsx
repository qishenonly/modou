/**
 * 对话流（Claude Desktop 式消息布局）：
 * - 用户消息：右侧气泡（奶油底色，无头像）；
 * - assistant：左侧 LogoMark 头像 + 正文，悬停出现复制按钮；
 * - 等待动画：running 且尚无任何输出时，显示脉冲圆点（Thinking）；
 * - 工具调用以卡片展示（Claude 式紧凑活动行）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ContextStateData, TodoItemData } from '@modou/core';
import type { TimelineEntry } from '../lib/state';
import { formatTokens } from '../lib/format';
import { Markdown } from '../lib/markdown';
import {
  ContextCard,
  CostCard,
  HelpCard,
  InitCard,
  McpCard,
  PlanCard,
  RewindCard,
  SnapshotsCard,
  type GuiCard,
} from './CommandCards';
import { LogoMark } from './LogoMark';
import { SubagentBlock } from './SubagentBlock';
import { TodoList } from './TodoList';
import { ToolCard } from './ToolCard';

/** 一张带唯一 id 的命令结果卡片（App 维护，ChatThread 渲染）。 */
export interface GuiCardEntry {
  readonly id: number;
  readonly card: GuiCard;
}

/** 按 kind 渲染一张命令结果卡片。 */
function CommandCardView({
  entry,
  onClose,
  onPlanAction,
}: {
  readonly entry: GuiCardEntry;
  readonly onClose: () => void;
  readonly onPlanAction: (action: 'approve' | 'modify' | 'reject') => void;
}): ReactNode {
  const card = entry.card;
  switch (card.kind) {
    case 'help':
      return <HelpCard onClose={onClose} />;
    case 'cost':
      return <CostCard data={card.data} onClose={onClose} />;
    case 'mcp':
      return <McpCard data={card.data} onClose={onClose} />;
    case 'context':
      return <ContextCard data={card.data} onClose={onClose} />;
    case 'init':
      return <InitCard data={card.data} onClose={onClose} />;
    case 'snapshots':
      return <SnapshotsCard data={card.data} onClose={onClose} />;
    case 'rewind':
      return <RewindCard points={card.data} onClose={onClose} />;
    case 'plan':
      return (
        <PlanCard
          plan={card.data}
          onApprove={() => onPlanAction('approve')}
          onModify={() => onPlanAction('modify')}
          onReject={() => onPlanAction('reject')}
          onClose={onClose}
        />
      );
    default:
      return null;
  }
}

/** 等待指示：三个脉冲圆点（Claude 式）。 */
function ThinkingDots(): ReactNode {
  return (
    <div className="thinking-dots" role="status" aria-label="正在思考">
      <span className="thinking-dot" />
      <span className="thinking-dot" />
      <span className="thinking-dot" />
    </div>
  );
}

function UserMessage({
  text,
  onEdit,
}: {
  readonly text: string;
  readonly onEdit?: (text: string) => void;
}): ReactNode {
  return (
    <div className="msg msg-user">
      <div className="msg-user-col">
        <div className="msg-bubble msg-user-bubble">{text}</div>
        {onEdit !== undefined && (
          <button
            type="button"
            className="msg-copy msg-edit"
            onClick={() => onEdit(text)}
            title="编辑这条消息"
          >
            编辑
          </button>
        )}
      </div>
    </div>
  );
}

function AssistantMessage({
  text,
  onRegenerate,
  showActions,
}: {
  readonly text: string;
  readonly onRegenerate?: () => void;
  readonly showActions?: boolean;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时静默降级
    }
  };

  return (
    <div className="msg msg-assistant">
      <LogoMark size={26} className="msg-avatar" />
      <div className="msg-content">
        <div className="msg-bubble msg-assistant-bubble">
          <Markdown text={text} />
        </div>
        {showActions !== false && (
          <div className="msg-actions">
            <button
              type="button"
              className="msg-copy"
              onClick={() => void copy()}
              title="复制消息"
            >
              {copied ? '已复制' : '复制'}
            </button>
            {onRegenerate !== undefined && (
              <button
                type="button"
                className="msg-copy"
                onClick={onRegenerate}
                title="重新生成回复"
              >
                重新生成
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingBlock({ text }: { readonly text: string }): ReactNode {
  return (
    <details className="thinking">
      <summary>思考过程</summary>
      <pre>{text}</pre>
    </details>
  );
}

/**
 * 上下文用量指示器（Claude Desktop 式）：对话区顶部一条细进度条，
 * 显示当前上下文估算占用 / 模型窗口，并给出「临近压缩」告警色。
 * 悬停展示分项核算（与 /context 卡片同源）。
 */
function ContextGauge({
  context,
  contextWindow,
}: {
  readonly context: ContextStateData | null;
  readonly contextWindow: number | undefined;
}): ReactNode {
  if (context === null || contextWindow === undefined || contextWindow <= 0) {
    return null;
  }
  const used = context.total;
  const pct = Math.min(100, Math.round((used / contextWindow) * 100));
  const tone =
    context.nearCompaction || pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok';
  const breakdown =
    context.sections.length > 0
      ? context.sections
          .map((section) => `${section.name}: ${formatTokens(section.tokens)}`)
          .join('\n')
      : '';
  const title = [
    `上下文 ${formatTokens(used)} / ${formatTokens(contextWindow)} tokens`,
    breakdown,
    context.nearCompaction ? '即将压缩（靠近上下文上限）' : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  return (
    <div className="context-gauge" title={title}>
      <div className="context-gauge-label">
        <span>上下文</span>
        <span>
          {formatTokens(used)} / {formatTokens(contextWindow)}
          {context.nearCompaction && ' · 即将压缩'}
        </span>
      </div>
      <div className="context-gauge-track">
        <div
          className={`context-gauge-fill context-gauge-${tone}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function ChatThread({
  timeline,
  streamingText,
  thinking,
  todo,
  cards,
  notices,
  error,
  running,
  context,
  contextWindow,
  onCloseCard,
  onPlanAction,
  onRegenerate,
  onEditUser,
}: {
  readonly timeline: readonly TimelineEntry[];
  readonly streamingText: string;
  readonly thinking: string;
  readonly todo: readonly TodoItemData[];
  readonly cards: readonly GuiCardEntry[];
  readonly notices: readonly {
    readonly id: number;
    readonly level: string;
    readonly text: string;
  }[];
  readonly error: string | null;
  readonly running: boolean;
  readonly context: ContextStateData | null;
  readonly contextWindow: number | undefined;
  readonly onCloseCard: (id: number) => void;
  readonly onPlanAction: (action: 'approve' | 'modify' | 'reject') => void;
  readonly onRegenerate: () => void;
  readonly onEditUser: (text: string) => void;
}): ReactNode {
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLElement>(null);
  // 自动滚动：用户停留在底部附近才跟随（上滚阅读历史时不打断）
  const [sticky, setSticky] = useState(true);

  useEffect(() => {
    if (sticky) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [timeline, streamingText, notices, running, cards, sticky]);

  const onScroll = (): void => {
    const el = chatRef.current;
    if (el === null) return;
    setSticky(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
  };

  // 等待动画触发条件：running 且「没有文本、没有思考、没有进行中工具」
  const hasOutput =
    streamingText.length > 0 ||
    thinking.length > 0 ||
    timeline.some(
      (entry) =>
        entry.kind === 'tool' &&
        (entry.entry.status === 'pending' || entry.entry.status === 'running'),
    );
  const showThinking = running && !hasOutput;

  // 操作按钮（复制 / 重新生成）只显示在最后一条 assistant 回复（非运行中）
  let lastAssistantIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index].kind === 'assistant') {
      lastAssistantIndex = index;
      break;
    }
  }

  return (
    <main className="chat" ref={chatRef} onScroll={onScroll}>
      <div className="chat-inner">
        <ContextGauge context={context} contextWindow={contextWindow} />
        <TodoList items={todo} />

        {timeline.map((entry, index) => {
          if (entry.kind === 'user') {
            return (
              <UserMessage
                key={entry.id}
                text={entry.text}
                onEdit={onEditUser}
              />
            );
          }
          if (entry.kind === 'assistant') {
            return (
              <AssistantMessage
                key={entry.id}
                text={entry.text}
                onRegenerate={onRegenerate}
                showActions={index === lastAssistantIndex && !running}
              />
            );
          }
          if (entry.kind === 'subagent') {
            return <SubagentBlock key={entry.id} entry={entry.entry} />;
          }
          return <ToolCard key={entry.id} entry={entry.entry} />;
        })}

        {cards.map((entry) => (
          <CommandCardView
            key={entry.id}
            entry={entry}
            onClose={() => onCloseCard(entry.id)}
            onPlanAction={onPlanAction}
          />
        ))}

        {thinking.length > 0 && <ThinkingBlock text={thinking} />}

        {streamingText.length > 0 && (
          <div className="msg msg-assistant">
            <LogoMark size={26} className="msg-avatar" />
            <div className="msg-content">
              <div className="msg-bubble msg-assistant-bubble">
                <Markdown text={streamingText} />
              </div>
            </div>
          </div>
        )}

        {showThinking && (
          <div className="msg msg-assistant">
            <LogoMark size={26} className="msg-avatar" />
            <div className="msg-content">
              <ThinkingDots />
            </div>
          </div>
        )}

        {notices.map((notice) => (
          <div key={notice.id} className={`notice notice-${notice.level}`}>
            {notice.text}
          </div>
        ))}

        {error !== null && (
          <div className="notice notice-error">错误：{error}</div>
        )}

        <div ref={bottomRef} />
      </div>
    </main>
  );
}
