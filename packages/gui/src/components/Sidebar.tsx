/**
 * 左侧会话侧栏（Claude Desktop 式）：新建会话 + 历史会话列表。
 * 会话来自 listSessions（当前项目的可恢复会话，时间倒序）。
 */
import type { ReactNode } from 'react';
import type { ResumeCandidate } from '@modou/core';
import { formatTime } from '../lib/format';

export function Sidebar({
  projectName,
  currentSessionId,
  sessions,
  running,
  onNewChat,
  onResume,
  onDelete,
  onOpenSettings,
}: {
  readonly projectName: string;
  readonly currentSessionId: string | null;
  readonly sessions: readonly ResumeCandidate[];
  readonly running: boolean;
  readonly onNewChat: () => void;
  readonly onResume: (sessionId: string) => void;
  readonly onDelete: (sessionId: string) => void;
  readonly onOpenSettings: () => void;
}): ReactNode {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">墨</div>
        <div className="brand-text">
          <div className="brand-name">modou</div>
          <div className="brand-project" title={projectName}>
            {projectName}
          </div>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-new"
        onClick={onNewChat}
        disabled={running}
        title={
          running ? '任务运行中，结束后可新建会话' : '开启新会话（/clear）'
        }
      >
        + 新建会话
      </button>

      <nav className="session-list">
        {sessions.length === 0 && (
          <div className="session-empty">还没有历史会话</div>
        )}
        {sessions.map((session) => {
          const active = session.sessionId === currentSessionId;
          return (
            <div
              key={session.sessionId}
              className={`session-item${active ? ' session-active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onResume(session.sessionId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onResume(session.sessionId);
                }
              }}
            >
              <div className="session-preview" title={session.preview}>
                {session.preview || '（空会话）'}
              </div>
              <div className="session-meta">
                <span>{formatTime(session.lastTs)}</span>
                <span className="session-count">{session.entryCount} 条</span>
                {!active && (
                  <button
                    type="button"
                    className="session-delete"
                    title="删除会话"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(session.sessionId);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onOpenSettings}
        >
          ⚙ 设置
        </button>
      </div>
    </aside>
  );
}
