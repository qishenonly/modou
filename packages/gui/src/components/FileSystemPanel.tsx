/**
 * 右侧文件系统面板（Codex 式）：
 * - 「文件」页签：递归文件树浏览（目录可折叠）+ 点击文件在下方预览内容；
 * - 「变更」页签：占位（git 变更在 T-3 接入）。
 * 数据走 Electron IPC（window.modou.getFileTree / readFile），渲染进程不持有 Node 能力。
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { formatBytes, formatTime } from '../lib/format';
import type { FileTreeNode, ReadFileResult } from '../../electron/ipc';

/** 已选中文件（path 相对 cwd；size/mtime 来自树节点，供预览头部展示）。 */
interface SelectedFile {
  readonly path: string;
  readonly size?: number;
  readonly mtime?: number;
}

/** 文件树加载状态。 */
type TreeState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly root: string;
      readonly tree: readonly FileTreeNode[];
    };

/** 预览加载状态（result 为最近一次 readFile 的返回）。 */
type PreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly result: ReadFileResult };

/** 内联 SVG：目录折叠/展开的 chevron（右向，展开时旋转 90°）。 */
function ChevronIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" className="fs-chevron" aria-hidden="true">
      <path
        d="M6 3.5 10.5 8 6 12.5"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 内联 SVG：文件夹图标（开口）。 */
function FolderIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" className="fs-icon" aria-hidden="true">
      <path
        d="M1.75 4.25A1.75 1.75 0 0 1 3.5 2.5h2.586c.464 0 .91.184 1.238.513L8.56 4.25h3.94a1.75 1.75 0 0 1 1.75 1.75v6.5a1.75 1.75 0 0 1-1.75 1.75H3.5a1.75 1.75 0 0 1-1.75-1.75v-8Z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 内联 SVG：文件图标（文档轮廓 + 折角）。 */
function FileIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" className="fs-icon" aria-hidden="true">
      <path
        d="M3.5 2.25a.75.75 0 0 1 .75-.75h5.086c.199 0 .39.079.53.22l2.914 2.914c.141.141.22.332.22.53v8.586a.75.75 0 0 1-.75.75h-8a.75.75 0 0 1-.75-.75v-11.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 2.5v2.75H12.25"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 递归渲染树节点；目录行点击折叠/展开，文件行点击选中并触发预览。 */
function TreeRow({
  node,
  depth,
  expanded,
  selectedPath,
  onToggle,
  onSelect,
}: {
  readonly node: FileTreeNode;
  readonly depth: number;
  readonly expanded: ReadonlySet<string>;
  readonly selectedPath: string | null;
  readonly onToggle: (path: string) => void;
  readonly onSelect: (node: FileTreeNode) => void;
}): ReactNode {
  const indent = { '--fs-depth': depth } as CSSProperties;

  if (node.type === 'file') {
    const active = selectedPath === node.path;
    return (
      <button
        type="button"
        className={`fs-tree-row fs-tree-file${active ? ' fs-tree-file-active' : ''}`}
        style={indent}
        onClick={() => onSelect(node)}
        title={node.path}
      >
        <FileIcon />
        <span className="fs-tree-name">{node.name}</span>
      </button>
    );
  }

  const open = expanded.has(node.path);
  return (
    <>
      <button
        type="button"
        className={`fs-tree-row fs-tree-dir${open ? ' fs-tree-dir-open' : ''}`}
        style={indent}
        onClick={() => onToggle(node.path)}
        title={node.path}
      >
        <ChevronIcon />
        <FolderIcon />
        <span className="fs-tree-name">{node.name}</span>
      </button>
      {open &&
        (node.children ?? []).map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            selectedPath={selectedPath}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

/** 预览区：头部（路径 + 大小/时间 + 徽标）+ 正文（等宽 pre）。 */
function FilePreview({
  selected,
  state,
}: {
  readonly selected: SelectedFile | null;
  readonly state: PreviewState;
}): ReactNode {
  return (
    <div className="fs-preview">
      {selected === null ? (
        <div className="fs-placeholder">选择文件查看内容</div>
      ) : (
        <>
          <div className="fs-preview-head">
            <span className="fs-preview-path" title={selected.path}>
              {selected.path}
            </span>
            <div className="fs-preview-meta">
              {state.status === 'done' && state.result.binary && (
                <span className="fs-badge">二进制</span>
              )}
              {state.status === 'done' && state.result.truncated && (
                <span className="fs-badge">已截断</span>
              )}
              {selected.size !== undefined && (
                <span>{formatBytes(selected.size)}</span>
              )}
              {selected.mtime !== undefined && (
                <span>{formatTime(selected.mtime)}</span>
              )}
            </div>
          </div>
          <div className="fs-preview-body">
            {state.status === 'loading' && (
              <div className="fs-hint">加载中…</div>
            )}
            {state.status === 'done' &&
              (state.result.binary ? (
                <div className="fs-hint">二进制文件，无法预览</div>
              ) : state.result.ok && state.result.content !== null ? (
                <pre className="fs-preview-pre">{state.result.content}</pre>
              ) : (
                <div className="fs-hint fs-hint-error">
                  {state.result.message ?? '读取文件失败'}
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

export function FileSystemPanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [tab, setTab] = useState<'files' | 'changes'>('files');
  const [treeState, setTreeState] = useState<TreeState>({ status: 'loading' });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>({
    status: 'idle',
  });

  // 挂载时加载文件树；成功后默认展开根下第一层目录。
  useEffect(() => {
    let cancelled = false;
    setTreeState({ status: 'loading' });
    void window.modou
      .getFileTree()
      .then((result) => {
        if (cancelled) return;
        if (result.ok && result.tree !== null) {
          const initial = new Set<string>();
          for (const node of result.tree) {
            if (node.type === 'dir') initial.add(node.path);
          }
          setExpanded(initial);
          setTreeState({
            status: 'ready',
            root: result.root,
            tree: result.tree,
          });
        } else {
          setTreeState({
            status: 'error',
            message: result.message ?? '加载文件树失败',
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTreeState({ status: 'error', message: '加载文件树失败' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 选中文件后触发预览读取；切换文件时取消旧请求。
  useEffect(() => {
    if (selected === null) {
      setPreviewState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setPreviewState({ status: 'loading' });
    void window.modou
      .readFile(selected.path)
      .then((result) => {
        if (!cancelled) setPreviewState({ status: 'done', result });
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewState({
            status: 'done',
            result: {
              ok: false,
              path: selected.path,
              content: null,
              binary: false,
              truncated: false,
              message: '读取文件失败',
            },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const toggleDir = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectFile = (node: FileTreeNode): void => {
    setSelected((prev) =>
      prev?.path === node.path
        ? prev
        : { path: node.path, size: node.size, mtime: node.mtime },
    );
  };

  return (
    <aside className="fs-panel">
      <div className="fs-head">
        <span className="fs-title">文件系统</span>
        <button type="button" className="panel-close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="fs-tabs">
        <button
          type="button"
          className={`fs-tab${tab === 'files' ? ' fs-tab-active' : ''}`}
          onClick={() => setTab('files')}
        >
          文件
        </button>
        <button
          type="button"
          className={`fs-tab${tab === 'changes' ? ' fs-tab-active' : ''}`}
          onClick={() => setTab('changes')}
        >
          变更
        </button>
      </div>
      {tab === 'changes' ? (
        <div className="fs-placeholder">git 变更即将接入</div>
      ) : (
        <div className="fs-body">
          <div className="fs-tree">
            {treeState.status === 'loading' && (
              <div className="fs-hint">加载中…</div>
            )}
            {treeState.status === 'error' && (
              <div className="fs-hint fs-hint-error">{treeState.message}</div>
            )}
            {treeState.status === 'ready' && treeState.tree.length === 0 && (
              <div className="fs-hint">（空目录）</div>
            )}
            {treeState.status === 'ready' &&
              treeState.tree.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  selectedPath={selected?.path ?? null}
                  onToggle={toggleDir}
                  onSelect={selectFile}
                />
              ))}
          </div>
          <FilePreview selected={selected} state={previewState} />
        </div>
      )}
    </aside>
  );
}
