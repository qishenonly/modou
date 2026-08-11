/**
 * 左侧会话侧栏（Claude Desktop 式）：
 * - 顶部：品牌标 + 项目切换（当前目录名 + 切换按钮，无项目时「选择项目目录」）；
 * - 「+ 新对话」主按钮；
 * - 会话搜索框 + 历史列表（自定义标题优先、预览兜底；当前高亮；悬停可重命名/删除）；
 * - 底部：模型选择器 + 设置。
 */
import {
  useEffect,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { ResumeCandidate } from '@modou/core';
import type { SessionSearchResult } from '../../electron/ipc';
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
  onOpenTasks,
  onOpenUsage,
  onOpenFiles,
  onOpenSearchResult,
  onExportSession,
  archived,
  onToggleArchive,
}: {
  readonly projectName: string;
  readonly hasProject: boolean;
  readonly currentSessionId: string | null;
  readonly sessions: readonly ResumeCandidate[];
  readonly running: boolean;
  readonly titles: Readonly<Record<string, string>>;
  /** 已归档会话 ID（归档后从主列表隐藏）。 */
  readonly archived: ReadonlySet<string>;
  /** 归档 / 移出归档一条会话。 */
  readonly onToggleArchive: (sessionId: string) => void;
  readonly onNewChat: () => void;
  readonly onResume: (sessionId: string) => void;
  readonly onDelete: (sessionId: string) => void;
  readonly onRename: (sessionId: string, title: string) => void;
  readonly onSelectDirectory: () => void;
  readonly onOpenSettings: () => void;
  readonly onCollapse: () => void;
  readonly onOpenTasks: () => void;
  readonly onOpenUsage: () => void;
  readonly onOpenFiles: () => void;
  /** 搜索命中跳转：恢复对应会话并定位到命中消息。 */
  readonly onOpenSearchResult: (sessionId: string, seq: number) => void;
  /** 导出会话为 markdown（主进程弹保存对话框）。 */
  readonly onExportSession?: (sessionId: string) => void;
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
  // 会话列表标题行：搜索框开合 / 全选批量删除模式
  const [searchOpen, setSearchOpen] = useState(false);
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // 会话内容级搜索命中（Claude Desktop 式全文检索；null = 无查询未搜索）
  const [results, setResults] = useState<readonly SessionSearchResult[] | null>(
    null,
  );
  // 搜索范围：当前项目（默认）/ 全部项目
  const [allProjects, setAllProjects] = useState(false);
  // 会话列表键盘导航焦点（ArrowUp / ArrowDown / Enter）
  const [navIndex, setNavIndex] = useState(0);
  // 归档视图开合（true = 只显示已归档会话）
  const [showArchived, setShowArchived] = useState(false);

  const toggleSelected = (sessionId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const exitBatch = (): void => {
    setBatch(false);
    setSelected(new Set());
  };

  const deleteSelected = (): void => {
    for (const sessionId of selected) onDelete(sessionId);
    exitBatch();
  };

  const visible = sessions.filter((session) => {
    const isArchived = archived.has(session.sessionId);
    if (isArchived && !showArchived) return false;
    if (!isArchived && showArchived) return false;
    if (query.trim().length === 0) return true;
    const haystack =
      `${titles[session.sessionId] ?? ''} ${session.preview}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  // 内容级全文搜索命中（Claude Desktop 式）；标题命中之外的结果去重合并；
  // 归档会话只在归档视图中显示
  const needle = query.trim();
  const contentResults =
    needle.length > 0
      ? (results ?? []).filter(
          (result) => archived.has(result.sessionId) === showArchived,
        )
      : null;
  const contentIds = new Set(
    contentResults?.map((result) => result.sessionId) ?? [],
  );
  const titleOnly = visible.filter(
    (session) => !contentIds.has(session.sessionId),
  );

  // 内容级全文搜索（防抖 200ms；默认当前项目，可切全部项目）
  useEffect(() => {
    const needle = query.trim();
    if (needle.length === 0) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      void window.modou.searchSessions(needle, allProjects).then(setResults);
    }, 200);
    return () => clearTimeout(timer);
  }, [query, allProjects]);

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

  /** 渲染一条会话列表项（标题/预览 + 重命名/删除/右键菜单）。 */
  const renderSessionItem = (
    session: ResumeCandidate,
    nav = false,
  ): ReactNode => {
    const active = session.sessionId === currentSessionId;
    const editing = editingId === session.sessionId;
    const title = titles[session.sessionId] ?? session.preview ?? '（空会话）';
    return (
      <div
        key={session.sessionId}
        className={`session-item${active ? ' session-active' : ''}${nav ? ' session-nav-active' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => {
          if (batch) toggleSelected(session.sessionId);
          else if (!editing) onResume(session.sessionId);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (batch) return;
          setCtx({
            x: event.clientX,
            y: event.clientY,
            sessionId: session.sessionId,
          });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (batch) toggleSelected(session.sessionId);
            else if (!editing) onResume(session.sessionId);
          }
        }}
      >
        {batch && (
          <input
            type="checkbox"
            className="session-check"
            checked={selected.has(session.sessionId)}
            onChange={() => toggleSelected(session.sessionId)}
            onClick={(event) => event.stopPropagation()}
          />
        )}
        {editing ? (
          <input
            className="session-rename-input"
            value={editValue}
            autoFocus
            placeholder="会话标题"
            onChange={(event) => setEditValue(event.target.value)}
            onKeyDown={(event) => onEditKeyDown(event, session.sessionId)}
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
              {!active && !batch && (
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
  };

  /** 渲染一条内容搜索命中项（Claude Desktop 式：标题 + 命中片段 + 命中数）。 */
  const renderSearchHit = (
    result: SessionSearchResult,
    nav = false,
  ): ReactNode => {
    const session = sessions.find((s) => s.sessionId === result.sessionId);
    const title = titles[result.sessionId] ?? session?.preview ?? '（空会话）';
    const active = result.sessionId === currentSessionId;
    const open = (): void => onOpenSearchResult(result.sessionId, result.seq);
    return (
      <div
        key={result.sessionId}
        className={`session-item${active ? ' session-active' : ''}${nav ? ' session-nav-active' : ''}`}
        role="button"
        tabIndex={0}
        title={title}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
          }
        }}
      >
        <div className="session-preview" title={title}>
          {title}
        </div>
        <div className="session-meta">
          <span>{formatTime(result.lastTs)}</span>
          {!result.current && (
            <span className="session-project-tag">其他项目</span>
          )}
          <span className="session-hit-count">{result.count} 条命中</span>
        </div>
        <div className="session-snippet" title={result.snippet}>
          {result.snippet}
        </div>
      </div>
    );
  };

  /** 当前渲染的会话项数组（搜索时 = 内容命中 + 标题命中；否则 = 全部可见）。 */
  const displayItems: readonly (
    | {
        readonly kind: 'hit';
        readonly sessionId: string;
        readonly result: SessionSearchResult;
      }
    | {
        readonly kind: 'session';
        readonly sessionId: string;
        readonly session: ResumeCandidate;
      }
  )[] =
    needle.length > 0
      ? [
          ...(contentResults ?? []).map((result) => ({
            kind: 'hit' as const,
            sessionId: result.sessionId,
            result,
          })),
          ...titleOnly.map((session) => ({
            kind: 'session' as const,
            sessionId: session.sessionId,
            session,
          })),
        ]
      : visible.map((session) => ({
          kind: 'session' as const,
          sessionId: session.sessionId,
          session,
        }));

  /** 会话列表键盘导航（↑ / ↓ 移动焦点，Enter 激活；在列表容器上监听）。 */
  const onNavKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (displayItems.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setNavIndex((prev) => Math.min(prev + 1, displayItems.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setNavIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      const item = displayItems[navIndex];
      if (item === undefined) return;
      event.preventDefault();
      if (item.kind === 'hit') {
        onOpenSearchResult(item.sessionId, item.result.seq);
      } else {
        onResume(item.sessionId);
      }
    }
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

        <div className="utility-row">
          <button type="button" className="utility-btn" onClick={onOpenTasks}>
            <svg
              viewBox="0 0 16 16"
              className="utility-icon"
              aria-hidden="true"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <path
                d="M8 4.5V8l2.5 1.5"
                stroke="currentColor"
                strokeWidth="1.3"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
            定时任务
          </button>
          <button type="button" className="utility-btn" onClick={onOpenUsage}>
            <svg
              viewBox="0 0 16 16"
              className="utility-icon"
              aria-hidden="true"
            >
              <path
                d="M4 9h2v4H4zM7 6h2v7H7zM10 3h2v10h-2z"
                fill="currentColor"
              />
            </svg>
            用量
          </button>
        </div>

        {hasProject && sessions.length > 0 && (
          <div className="history-header">
            <span className="history-title">{projectName}</span>
            <div className="history-actions">
              <button
                type="button"
                className="history-icon"
                title="搜索会话"
                onClick={() => {
                  setSearchOpen((prev) => !prev);
                  if (!searchOpen) setBatch(false);
                }}
              >
                <svg
                  viewBox="0 0 16 16"
                  className="history-icon-svg"
                  aria-hidden="true"
                >
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
              </button>
              <button
                type="button"
                className={`history-icon${showArchived ? ' history-icon-active' : ''}`}
                title={
                  showArchived
                    ? '退出归档视图'
                    : archived.size > 0
                      ? `查看归档（${archived.size}）`
                      : '归档（无）'
                }
                onClick={() => {
                  setShowArchived((prev) => !prev);
                  if (!showArchived) {
                    setSearchOpen(false);
                    setBatch(false);
                  }
                }}
              >
                <svg
                  viewBox="0 0 16 16"
                  className="history-icon-svg"
                  aria-hidden="true"
                >
                  <path
                    d="M2.5 3.5h11l-4.4 5.2v3.3l-2.2 1.2V8.7L2.5 3.5Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M2.5 5h11"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className={`history-icon${batch ? ' history-icon-active' : ''}`}
                title={batch ? '退出批量选择' : '批量选择'}
                onClick={() => {
                  setBatch((prev) => !prev);
                  if (batch) setSelected(new Set());
                }}
              >
                <svg
                  viewBox="0 0 16 16"
                  className="history-icon-svg"
                  aria-hidden="true"
                >
                  <rect
                    x="3"
                    y="3"
                    width="10"
                    height="10"
                    rx="2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                  <path
                    d="M6 8.3 7.4 9.7 10.2 6.6"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </div>
        )}

        {searchOpen && hasProject && sessions.length > 0 && (
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
            <button
              type="button"
              className={`search-scope${allProjects ? ' search-scope-on' : ''}`}
              title={allProjects ? '正在搜索全部项目' : '正在搜索当前项目'}
              onClick={() => setAllProjects((prev) => !prev)}
            >
              {allProjects ? '全部' : '本项目'}
            </button>
          </div>
        )}

        {batch && selected.size > 0 && (
          <div className="batch-bar">
            <span>已选 {selected.size} 个</span>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={deleteSelected}
            >
              删除
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={exitBatch}
            >
              取消
            </button>
          </div>
        )}

        <nav
          className="session-list"
          tabIndex={0}
          onKeyDown={onNavKeyDown}
          onFocus={() => setNavIndex(0)}
        >
          {needle.length > 0 ? (
            <>
              {displayItems.length === 0 && (
                <div className="session-empty">
                  {contentResults === null ? '搜索中…' : '没有匹配的会话'}
                </div>
              )}
              {displayItems.map((item, index) =>
                item.kind === 'hit'
                  ? renderSearchHit(item.result, index === navIndex)
                  : renderSessionItem(item.session, index === navIndex),
              )}
            </>
          ) : (
            <>
              {displayItems.length === 0 && (
                <div className="session-empty">
                  {hasProject ? '还没有历史对话' : '先选择项目目录'}
                </div>
              )}
              {visible.map((session, index) =>
                renderSessionItem(session, index === navIndex),
              )}
            </>
          )}
        </nav>
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="icon-btn"
          onClick={onOpenFiles}
          title="文件系统面板"
        >
          <svg viewBox="0 0 16 16" className="icon-folder" aria-hidden="true">
            <path
              d="M1.75 4.25A1.75 1.75 0 0 1 3.5 2.5h2.586c.464 0 .91.184 1.238.513L8.56 4.25h3.94a1.75 1.75 0 0 1 1.75 1.75v6.5a1.75 1.75 0 0 1-1.75 1.75H3.5a1.75 1.75 0 0 1-1.75-1.75v-8Z"
              stroke="currentColor"
              strokeWidth="1.3"
              fill="none"
              strokeLinejoin="round"
            />
          </svg>
        </button>
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
              className="ctx-item"
              onClick={() => {
                onToggleArchive(ctx.sessionId);
                setCtx(null);
              }}
            >
              {archived.has(ctx.sessionId) ? '移出归档' : '归档会话'}
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
                if (onExportSession !== undefined)
                  onExportSession(ctx.sessionId);
                setCtx(null);
              }}
            >
              导出会话…
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
