/**
 * 对话流（Claude Desktop 式消息布局）：
 * - 用户消息：右侧气泡（奶油底色，无头像）；
 * - assistant：左侧 LogoMark 头像 + 正文，悬停出现复制按钮；
 * - 等待动画：running 且尚无任何输出时，显示脉冲圆点（Thinking）；
 * - 工具调用以卡片展示（Claude 式紧凑活动行）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TodoItemData } from '@modou/core';
import type { ChatMessage, SubagentEntry } from '../lib/state';
import type { ToolCallEntry } from '../lib/tools';
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

function UserMessage({ text }: { readonly text: string }): ReactNode {
  return (
    <div className="msg msg-user">
      <div className="msg-bubble msg-user-bubble">{text}</div>
    </div>
  );
}

function AssistantMessage({
  text,
  onRegenerate,
}: {
  readonly text: string;
  readonly onRegenerate?: () => void;
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

export function ChatThread({
  history,
  streamingText,
  thinking,
  tools,
  todo,
  subagents,
  cards,
  notices,
  error,
  running,
  onCloseCard,
  onPlanAction,
  onRegenerate,
}: {
  readonly history: readonly ChatMessage[];
  readonly streamingText: string;
  readonly thinking: string;
  readonly tools: readonly ToolCallEntry[];
  readonly todo: readonly TodoItemData[];
  readonly subagents: readonly SubagentEntry[];
  readonly cards: readonly GuiCardEntry[];
  readonly notices: readonly {
    readonly id: number;
    readonly level: string;
    readonly text: string;
  }[];
  readonly error: string | null;
  readonly running: boolean;
  readonly onCloseCard: (id: number) => void;
  readonly onPlanAction: (action: 'approve' | 'modify' | 'reject') => void;
  readonly onRegenerate: () => void;
}): ReactNode {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [history, streamingText, tools, notices, running, cards]);

  // 等待动画触发条件：running 且「没有文本、没有思考、没有进行中工具」
  const hasOutput =
    streamingText.length > 0 ||
    thinking.length > 0 ||
    tools.some(
      (entry) => entry.status === 'pending' || entry.status === 'running',
    );
  const showThinking = running && !hasOutput;

  return (
    <main className="chat">
      <div className="chat-inner">
        <TodoList items={todo} />

        {history.map((entry, index) =>
          entry.role === 'user' ? (
            <UserMessage key={index} text={entry.text} />
          ) : (
            <AssistantMessage
              key={index}
              text={entry.text}
              onRegenerate={onRegenerate}
            />
          ),
        )}

        {cards.map((entry) => (
          <CommandCardView
            key={entry.id}
            entry={entry}
            onClose={() => onCloseCard(entry.id)}
            onPlanAction={onPlanAction}
          />
        ))}

        {subagents.map((entry) => (
          <SubagentBlock key={entry.id} entry={entry} />
        ))}

        {thinking.length > 0 && <ThinkingBlock text={thinking} />}

        {tools.map((entry) => (
          <ToolCard key={entry.id} entry={entry} />
        ))}

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
