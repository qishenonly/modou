/**
 * 统一命令面板（Cmd+K；Claude Desktop / Codex 式）：一个搜索框检索三类入口——
 * 斜杠命令 / 历史会话 / 项目文件。方向键上下选择、Enter 执行、Esc 关闭；
 * 也支持鼠标点击。文件列表来自 getFileTree（渲染进程拍平，受树遍历上限约束）。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { ResumeCandidate } from '@modou/core';
import type { FileTreeNode } from '../../electron/ipc';
import { BUILTIN_SLASH_COMMANDS } from '../../electron/slash';

/** 文件树节点 → 相对路径扁平列表（目录不进入，只收文件）。 */
function flattenFiles(
  nodes: readonly FileTreeNode[],
  prefix = '',
  out: string[] = [],
): string[] {
  for (const node of nodes) {
    const path = prefix.length === 0 ? node.name : `${prefix}/${node.name}`;
    if (node.type === 'file') out.push(path);
    else if (node.children !== undefined)
      flattenFiles(node.children, path, out);
  }
  return out;
}

/** 面板条目（三类统一为判别联合，列表渲染与键盘导航共用）。 */
type PaletteItem =
  | {
      readonly kind: 'command';
      readonly id: string;
      readonly title: string;
      readonly desc: string;
    }
  | {
      readonly kind: 'session';
      readonly id: string;
      readonly title: string;
      readonly desc: string;
    }
  | {
      readonly kind: 'file';
      readonly id: string;
      readonly title: string;
      readonly desc: string;
    };

export function CommandPalette({
  sessions,
  titles,
  onClose,
  onRunCommand,
  onResume,
  onOpenFile,
}: {
  readonly sessions: readonly ResumeCandidate[];
  readonly titles: Readonly<Record<string, string>>;
  readonly onClose: () => void;
  /** 执行一条斜杠命令（传完整命令文本，App 走命令分发）。 */
  readonly onRunCommand: (text: string) => void;
  /** 恢复一个会话。 */
  readonly onResume: (sessionId: string) => void;
  /** 在系统文件管理器中打开一个文件（相对 cwd 的路径）。 */
  readonly onOpenFile: (path: string) => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<readonly string[] | null>(null);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 文件列表只拉一次（挂载时）
  useEffect(() => {
    void window.modou.getFileTree().then((result) => {
      if (result.ok && result.tree !== null)
        setFiles(flattenFiles(result.tree));
      else setFiles([]);
    });
    inputRef.current?.focus();
  }, []);

  const needle = query.trim().toLowerCase();
  const items = useMemo<readonly PaletteItem[]>(() => {
    const commands: readonly PaletteItem[] = BUILTIN_SLASH_COMMANDS.filter(
      (command) =>
        needle.length === 0 ||
        command.name.includes(needle) ||
        command.description.toLowerCase().includes(needle),
    ).map((command) => ({
      kind: 'command',
      id: command.name,
      title: command.usage,
      desc: command.description,
    }));
    const sessionItems: readonly PaletteItem[] = sessions
      .filter(
        (session) =>
          needle.length === 0 ||
          (titles[session.sessionId] ?? session.preview)
            .toLowerCase()
            .includes(needle),
      )
      .map((session) => ({
        kind: 'session',
        id: session.sessionId,
        title: titles[session.sessionId] ?? session.preview ?? '（空会话）',
        desc: '历史会话',
      }));
    const fileItems: readonly PaletteItem[] = (files ?? [])
      .filter(
        (path) => needle.length === 0 || path.toLowerCase().includes(needle),
      )
      .slice(0, 30)
      .map((path) => ({ kind: 'file', id: path, title: path, desc: '文件' }));
    return [...commands, ...sessionItems, ...fileItems];
  }, [needle, sessions, titles, files]);

  // 选择与执行
  const activate = (item: PaletteItem): void => {
    if (item.kind === 'command') {
      const name = item.id;
      onRunCommand(name.startsWith('/') ? name : `/${name}`);
    } else if (item.kind === 'session') {
      onResume(item.id);
    } else {
      onOpenFile(item.id);
    }
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (items.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((prev) => Math.min(prev + 1, items.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[index];
      if (item !== undefined) activate(item);
    }
  };

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="命令面板"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette-input-row">
          <svg
            viewBox="0 0 16 16"
            className="palette-search-icon"
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
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            placeholder="搜索命令、会话或文件…"
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              // 输入框内方向键也交给面板统一处理（避免默认光标行为）
              if (
                event.key === 'ArrowDown' ||
                event.key === 'ArrowUp' ||
                event.key === 'Enter' ||
                event.key === 'Escape'
              ) {
                onKeyDown(event);
              }
            }}
          />
          <span className="palette-hint">↑↓ 选择 · Enter 执行 · Esc 关闭</span>
        </div>
        <div className="palette-list">
          {items.length === 0 ? (
            <div className="palette-empty">
              {files === null ? '加载中…' : '没有匹配的结果'}
            </div>
          ) : (
            items.map((item, itemIndex) => (
              <button
                key={`${item.kind}-${item.id}`}
                type="button"
                className={`palette-item${itemIndex === index ? ' palette-item-active' : ''}`}
                onClick={() => activate(item)}
                onMouseEnter={() => setIndex(itemIndex)}
              >
                <span className={`palette-kind palette-kind-${item.kind}`}>
                  {item.kind === 'command'
                    ? '命令'
                    : item.kind === 'session'
                      ? '会话'
                      : '文件'}
                </span>
                <span className="palette-title" title={item.title}>
                  {item.title}
                </span>
                <span className="palette-desc">{item.desc}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
