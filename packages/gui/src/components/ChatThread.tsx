/**
 * 对话流（中间主区）：历史消息 + 工具卡片 + 流式回复 + 思考折叠 + 提示/错误。
 * 自动滚到底部（用户上滚阅读历史时暂停跟随——MVP 简化为总是跟随）。
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ChatMessage } from '../lib/state';
import type { ToolCallEntry } from '../lib/tools';
import { Markdown } from '../lib/markdown';
import { ToolCard } from './ToolCard';

function UserMessage({ text }: { readonly text: string }): ReactNode {
  return (
    <div className="msg msg-user">
      <div className="msg-bubble">{text}</div>
    </div>
  );
}

function AssistantMessage({ text }: { readonly text: string }): ReactNode {
  return (
    <div className="msg msg-assistant">
      <div className="msg-role">assistant</div>
      <div className="msg-bubble">
        <Markdown text={text} />
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
  notices,
  error,
}: {
  readonly history: readonly ChatMessage[];
  readonly streamingText: string;
  readonly thinking: string;
  readonly tools: readonly ToolCallEntry[];
  readonly notices: readonly {
    readonly id: number;
    readonly level: string;
    readonly text: string;
  }[];
  readonly error: string | null;
}): ReactNode {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [history, streamingText, tools, notices]);

  return (
    <main className="chat">
      <div className="chat-inner">
        {history.map((entry, index) =>
          entry.role === 'user' ? (
            <UserMessage key={index} text={entry.text} />
          ) : (
            <AssistantMessage key={index} text={entry.text} />
          ),
        )}

        {thinking.length > 0 && <ThinkingBlock text={thinking} />}

        {tools.map((entry) => (
          <ToolCard key={entry.id} entry={entry} />
        ))}

        {streamingText.length > 0 && (
          <div className="msg msg-assistant">
            <div className="msg-role">assistant</div>
            <div className="msg-bubble">
              <Markdown text={streamingText} />
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
