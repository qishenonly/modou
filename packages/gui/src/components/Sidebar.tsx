/**
 * 左侧会话侧栏（Claude Desktop 式）：
 * - 顶部：品牌标 + 项目切换（当前目录名 + 切换按钮，无项目时「选择项目目录」）；
 * - 「+ 新对话」主按钮；
 * - 会话搜索框 + 历史列表（自定义标题优先、预览兜底；当前高亮；悬停可重命名/删除）；
 * - 底部：模型选择器 + 设置。
 */
import {
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { ResumeCandidate } from '@modou/core';
import { formatTime } from '../lib/format';
import { LogoMark } from './LogoMark';

export function Sidebar({
  projectName,
  hasProject,
  currentSessionId,
  sessions,
  running,
  titles,
  onNewChat,
  onResume,
  onDelete,
  onRename,
  onSelectDirectory,
  onOpenSettings,
  onCollapse,
}: {
  readonly projectName: string;
  readonly hasProject: boolean;
  readonly currentSessionId: string | null;
  readonly sessions: readonly ResumeCandidate[];
  readonly running: boolean;
  readonly titles: Readonly<Record<string, string>>;
  readonly onNewChat: () => void;
  readonly onResume: (sessionId: string) => void;
  readonly onDelete: (sessionId: string) => void;
  readonly onRename: (sessionId: string, title: string) => void;
  readonly onSelectDirectory: () => void;
  readonly onOpenSettings: () => void;
  readonly onCollapse: () => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  // 正在重命名的会话 ID（非空 = 该会话项处于编辑态）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  // 右键上下文菜单（Claude 式）
  const [ctx, setCtx] = useState<{
    readonly x: number;
    readonly y: number;
    readonly sessionId: string;
  } | null>(null);

  const visible = sessions.filter((session) => {
    if (query.trim().length === 0) return true;
    const haystack =
      `${titles[session.sessionId] ?? ''} ${session.preview}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  const startEdit = (session: ResumeCandidate): void => {
    setEditingId(session.sessionId);
    setEditValue(titles[session.sessionId] ?? session.preview ?? '');
  };

  const commitEdit = (sessionId: string): void => {
    onRename(sessionId, editValue.trim());
    setEditingId(null);
  };

  const onQueryChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setQuery(event.target.value);
  };

  const onEditKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    sessionId: string,
  ): void => {
    if (event.key === 'Enter') commitEdit(sessionId);
    else if (event.key === 'Escape') setEditingId(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <LogoMark size={26} />
          <span className="sidebar-brand-name">modou</span>
          <button
            type="button"
            className="sidebar-collapse"
            onClick={onCollapse}
            title="折叠侧栏"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M9.5 4 6 8l3.5 4"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <button
          type="button"
          className="project-picker"
          onClick={onSelectDirectory}
          title={hasProject ? '切换项目目录' : '选择项目目录'}
        >
          <svg viewBox="0 0 16 16" className="project-icon" aria-hidden="true">
            <path
              d="M1.75 3.5A1.75 1.75 0 0 1 3.5 1.75h2.586c.464 0 .91.184 1.238.513L8.56 3.5h3.94a1.75 1.75 0 0 1 1.75 1.75v6.5a1.75 1.75 0 0 1-1.75 1.75h-9.5A1.75 1.75 0 0 1 1.75 11.5v-8Z"
              fill="currentColor"
            />
          </svg>
          <span className="project-name" title={projectName}>
            {hasProject ? projectName : '选择项目目录'}
          </span>
          <span className="project-chevron">▾</span>
        </button>
      </div>

      <div className="sidebar-body">
        <button
          type="button"
          className="btn btn-new"
          onClick={onNewChat}
          disabled={!hasProject || running}
          title={
            !hasProject
              ? '先选择项目目录'
              : running
                ? '任务运行中，结束后可新建对话'
                : '开启新对话'
          }
        >
          <svg viewBox="0 0 16 16" className="btn-new-icon" aria-hidden="true">
            <path
              d="M8 3a.75.75 0 0 1 .75.75v3.5h3.5a.75.75 0 0 1 0 1.5h-3.5v3.5a.75.75 0 0 1-1.5 0v-3.5h-3.5a.75.75 0 0 1 0-1.5h3.5v-3.5A.75.75 0 0 1 8 3Z"
              fill="currentColor"
            />
          </svg>
          新对话
        </button>

        {hasProject && sessions.length > 0 && (
          <div className="session-search">
            <svg viewBox="0 0 16 16" className="search-icon" aria-hidden="true">
              <circle
                cx="7"
                cy="7"
                r="4.25"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="m10.5 10.5 3 3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <input
              className="search-input"
              value={query}
              onChange={onQueryChange}
              placeholder="搜索会话…"
            />
          </div>
        )}

        <nav className="session-list">
          {visible.length === 0 && (
            <div className="session-empty">
              {hasProject
                ? query.trim().length > 0
                  ? '没有匹配的会话'
                  : '还没有历史对话'
                : '先选择项目目录'}
            </div>
          )}
          {visible.map((session) => {
            const active = session.sessionId === currentSessionId;
            const editing = editingId === session.sessionId;
            const title =
              titles[session.sessionId] ?? session.preview ?? '（空会话）';
            return (
              <div
                key={session.sessionId}
                className={`session-item${active ? ' session-active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (!editing) onResume(session.sessionId);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setCtx({
                    x: event.clientX,
                    y: event.clientY,
                    sessionId: session.sessionId,
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (!editing) onResume(session.sessionId);
                  }
                }}
              >
                {editing ? (
                  <input
                    className="session-rename-input"
                    value={editValue}
                    autoFocus
                    placeholder="会话标题"
                    onChange={(event) => setEditValue(event.target.value)}
                    onKeyDown={(event) =>
                      onEditKeyDown(event, session.sessionId)
                    }
                    onBlur={() => commitEdit(session.sessionId)}
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : (
                  <>
                    <div className="session-preview" title={title}>
                      {title}
                    </div>
                    <div className="session-meta">
                      <span>{formatTime(session.lastTs)}</span>
                      <span className="session-count">
                        {session.entryCount} 条
                      </span>
                      {!active && (
                        <>
                          <button
                            type="button"
                            className="session-rename"
                            title="重命名会话"
                            onClick={(event) => {
                              event.stopPropagation();
                              startEdit(session);
                            }}
                          >
                            <svg
                              viewBox="0 0 16 16"
                              className="session-delete-icon"
                              aria-hidden="true"
                            >
                              <path
                                d="m9.9 2.8 3.3 3.3-7 7a.75.75 0 0 1-.32.19l-3.02.9a.25.25 0 0 1-.3-.3l.9-3.02a.75.75 0 0 1 .19-.32l7-7ZM10.6 2.1l1.7-1.7a.99.99 0 0 1 1.4 0l1.9 1.9a.99.99 0 0 1 0 1.4l-1.7 1.7-3.3-3.3Z"
                                fill="currentColor"
                              />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="session-delete"
                            title="删除会话"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDelete(session.sessionId);
                            }}
                          >
                            <svg
                              viewBox="0 0 16 16"
                              aria-hidden="true"
                              className="session-delete-icon"
                            >
                              <path
                                d="M6.5 2.5h3a.75.75 0 0 1 .75.75V4h-4.5v-.75a.75.75 0 0 1 .75-.75ZM4.75 5.5h6.5v6.5a1.75 1.75 0 0 1-1.75 1.75H6.5a1.75 1.75 0 0 1-1.75-1.75V5.5Zm1.5 1.25v5.5h1.5v-5.5h-1.5Zm2 0v5.5h1.5v-5.5h-1.5Z"
                                fill="currentColor"
                              />
                            </svg>
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="icon-btn"
          onClick={onOpenSettings}
          title="设置"
        >
          <svg viewBox="0 0 16 16" className="icon-gear" aria-hidden="true">
            <path
              d="M8 5.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5Zm5.4 3.42c.03-.22.03-.45 0-.67l1.36-1.06a.32.32 0 0 0 .08-.41l-1.29-2.23a.32.32 0 0 0-.39-.14l-1.6.65a4.7 4.7 0 0 0-1.16-.67L9.97 2.6a.32.32 0 0 0-.32-.26H7.1a.32.32 0 0 0-.32.26l-.31 1.72a4.7 4.7 0 0 0-1.16.67l-1.6-.65a.32.32 0 0 0-.39.14L2.03 6.71a.32.32 0 0 0 .08.41l1.36 1.06c-.03.22-.03.45 0 .67L2.11 9.9a.32.32 0 0 0-.08.41l1.29 2.23c.08.14.24.2.39.14l1.6-.65c.35.28.74.5 1.16.67l.31 1.72c.03.15.16.26.32.26h2.59c.16 0 .29-.11.32-.26l.31-1.72a4.7 4.7 0 0 0 1.16-.67l1.6.65c.15.06.31 0 .39-.14l1.29-2.23a.32.32 0 0 0-.08-.41l-1.36-1.06Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
      {/* 右键上下文菜单 */}
      {ctx !== null && (
        <>
          <div
            className="ctx-overlay"
            onClick={() => setCtx(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setCtx(null);
            }}
          />
          <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }}>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                onResume(ctx.sessionId);
                setCtx(null);
              }}
            >
              恢复会话
            </button>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                const session = sessions.find(
                  (s) => s.sessionId === ctx.sessionId,
                );
                if (session !== undefined) startEdit(session);
                setCtx(null);
              }}
            >
              重命名
            </button>
            <button
              type="button"
              className="ctx-item ctx-danger"
              onClick={() => {
                onDelete(ctx.sessionId);
                setCtx(null);
              }}
            >
              删除会话
            </button>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                void navigator.clipboard.writeText(ctx.sessionId);
                setCtx(null);
              }}
            >
              复制会话 ID
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
