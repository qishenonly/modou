/**
 * 右侧文件系统面板（Codex 式）：
 * - 「文件」页签：递归文件树浏览（目录可折叠）+ 点击文件在下方预览内容；
 * - 「变更」页签：git 工作区未提交改动列表 + 逐文件 unified diff；会话内工具编辑
 *   事件（diffs）作为「本轮编辑」折叠区补充标注（git 为主、会话事件为辅）。
 * 数据走 Electron IPC（getFileTree / readFile / getGitStatus / getGitDiff），
 * 渲染进程不持有 Node 能力。
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { formatBytes, formatTime } from '../lib/format';
import { buildDiffLines, parseUnifiedDiff, type DiffLine } from '../lib/tools';
import type {
  FileTreeNode,
  GitChangeEntry,
  GitDiffResult,
  ReadFileResult,
} from '../../electron/ipc';

/** 一次会话内文件变更（从 tool_result 的 Edit payload 收集；「本轮编辑」标注用）。 */
export interface DiffEntry {
  readonly id: string;
  readonly path?: string;
  readonly oldText: string;
  readonly newText: string;
}

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

/** git 工作区状态（getGitStatus 返回；git:false = 非仓库，仅会话编辑）。 */
type GitState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly git: boolean;
      readonly changes: readonly GitChangeEntry[];
    };

/** 选中变更的逐文件 diff 加载态。 */
type DiffState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly result: GitDiffResult };

/** diff 行前缀列：add `+`、remove `−`、header/context 空格。 */
function diffPrefix(kind: DiffLine['kind']): string {
  return kind === 'add' ? '+' : kind === 'remove' ? '−' : ' ';
}

/** 未跟踪文件全文按行切分（全标新增；空行保留，仅去尾部换行产生的空串）。 */
function splitUntracked(text: string): readonly string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** porcelain 状态码 → 中文标签与徽标配色（?? → 未跟踪、A 系 → 新增、D 系 → 删除、R 系 → 重命名、其余含 M → 修改）。 */
function changeLabel(status: string): {
  readonly label: string;
  readonly tone: 'warn' | 'ok' | 'fail' | 'muted';
} {
  if (status === '??') return { label: '未跟踪', tone: 'warn' };
  if (status.includes('A')) return { label: '新增', tone: 'ok' };
  if (status.includes('D')) return { label: '删除', tone: 'fail' };
  if (status.includes('R')) return { label: '重命名', tone: 'muted' };
  return { label: '修改', tone: 'muted' };
}

/** 状态徽标配色的追加类名（warn 用默认 .fs-badge）。 */
function badgeClass(tone: 'warn' | 'ok' | 'fail' | 'muted'): string {
  if (tone === 'ok') return ' fs-badge-ok';
  if (tone === 'fail') return ' fs-badge-fail';
  if (tone === 'muted') return ' fs-badge-muted';
  return '';
}

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

/** 变更页签的一行：状态徽标 + 已暂存/本轮小标 + 路径 + 行数。 */
function ChangeRow({
  change,
  active,
  inSession,
  onSelect,
}: {
  readonly change: GitChangeEntry;
  readonly active: boolean;
  readonly inSession: boolean;
  readonly onSelect: (path: string) => void;
}): ReactNode {
  const { label, tone } = changeLabel(change.status);
  return (
    <button
      type="button"
      className={`fs-change-row${active ? ' fs-change-active' : ''}`}
      onClick={() => onSelect(change.path)}
      title={change.path}
    >
      <span className={`fs-badge${badgeClass(tone)}`}>{label}</span>
      {change.staged && <span className="fs-change-staged">已暂存</span>}
      {inSession && <span className="fs-badge fs-badge-session">本轮</span>}
      <span className="fs-change-path">{change.path}</span>
      <span className="fs-change-stat">
        {change.added > 0 && (
          <span className="fs-change-stat-add">+{change.added}</span>
        )}
        {change.deleted > 0 && (
          <span className="fs-change-stat-del">−{change.deleted}</span>
        )}
      </span>
    </button>
  );
}

/** 「本轮编辑」折叠区：会话内 Edit/Write 事件的逐文件 diff（复用 .diff 系列）。 */
function SessionEdits({
  diffs,
}: {
  readonly diffs: readonly DiffEntry[];
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="fs-session">
      <button
        type="button"
        className="fs-session-head"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span
          className={`fs-session-chevron${open ? ' fs-session-chevron-open' : ''}`}
        >
          ▸
        </span>
        本轮编辑（{diffs.length}）
      </button>
      {open && (
        <div className="fs-session-body">
          {diffs.map((diff, index) => (
            <div key={diff.id} className="fs-session-item">
              <div className="fs-session-path" title={diff.path}>
                {diff.path ?? `变更 ${index + 1}`}
              </div>
              <div className="diff">
                {buildDiffLines(diff.oldText, diff.newText).map(
                  (line, lineIndex) => (
                    <div
                      key={lineIndex}
                      className={`diff-line diff-${line.kind}`}
                    >
                      <span className="diff-prefix">
                        {diffPrefix(line.kind)}
                      </span>
                      <span className="diff-text">{line.text}</span>
                    </div>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 变更页签主体：工作区变更列表（上，约 42%）→ 选中 diff（中，flex:1）→ 本轮编辑（下）。 */
function ChangesView({
  diffs,
}: {
  readonly diffs: readonly DiffEntry[];
}): ReactNode {
  const [gitState, setGitState] = useState<GitState>({ status: 'loading' });
  const [gitReload, setGitReload] = useState(0);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [diffState, setDiffState] = useState<DiffState>({ status: 'idle' });

  // 进入变更页签（挂载）时拉取 git 状态；刷新按钮递增 gitReload 重新拉取。
  useEffect(() => {
    let cancelled = false;
    setGitState({ status: 'loading' });
    void window.modou
      .getGitStatus()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setGitState({
            status: 'ready',
            git: result.git,
            changes: result.changes,
          });
        } else {
          setGitState({
            status: 'error',
            message: result.message ?? '获取 git 状态失败',
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitState({ status: 'error', message: '获取 git 状态失败' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [gitReload]);

  // 选中变更后拉取逐文件 unified diff；切换文件时取消旧请求。
  useEffect(() => {
    if (activePath === null) {
      setDiffState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setDiffState({ status: 'loading' });
    void window.modou
      .getGitDiff(activePath)
      .then((result) => {
        if (!cancelled) setDiffState({ status: 'done', result });
      })
      .catch(() => {
        if (!cancelled) {
          setDiffState({
            status: 'done',
            result: {
              ok: false,
              path: activePath,
              diff: '',
              untracked: false,
              message: '获取 diff 失败',
            },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  // 未跟踪文件全文全标新增；否则解析 unified diff。
  let diffLines: readonly DiffLine[] = [];
  if (diffState.status === 'done' && diffState.result.ok) {
    diffLines = diffState.result.untracked
      ? splitUntracked(diffState.result.diff).map((text) => ({
          kind: 'add' as const,
          text,
        }))
      : parseUnifiedDiff(diffState.result.diff);
  }

  return (
    <div className="fs-body">
      <div className="fs-changes">
        <div className="fs-changes-head">
          <span className="fs-changes-title">工作区变更</span>
          <button
            type="button"
            className="fs-refresh"
            onClick={() => setGitReload((prev) => prev + 1)}
            title="刷新"
          >
            ↻
          </button>
        </div>
        {gitState.status === 'loading' && (
          <div className="fs-hint">加载中…</div>
        )}
        {gitState.status === 'error' && (
          <div className="fs-hint fs-hint-error">{gitState.message}</div>
        )}
        {gitState.status === 'ready' && !gitState.git && (
          <div className="fs-hint">非 git 仓库，仅显示会话内编辑</div>
        )}
        {gitState.status === 'ready' &&
          gitState.git &&
          gitState.changes.length === 0 && (
            <div className="fs-hint">工作区干净，暂无未提交变更</div>
          )}
        {gitState.status === 'ready' && gitState.git && (
          <div className="fs-change-list">
            {gitState.changes.map((change) => (
              <ChangeRow
                key={change.path}
                change={change}
                active={activePath === change.path}
                inSession={diffs.some((diff) => diff.path === change.path)}
                onSelect={setActivePath}
              />
            ))}
          </div>
        )}
      </div>

      <div className="fs-change-diff">
        {diffState.status === 'idle' && (
          <div className="fs-hint">选择变更查看 diff</div>
        )}
        {diffState.status === 'loading' && (
          <div className="fs-hint">加载中…</div>
        )}
        {diffState.status === 'done' && diffState.result.ok && (
          <div className="diff">
            {diffLines.map((line, index) => (
              <div key={index} className={`diff-line diff-${line.kind}`}>
                <span className="diff-prefix">{diffPrefix(line.kind)}</span>
                <span className="diff-text">{line.text}</span>
              </div>
            ))}
          </div>
        )}
        {diffState.status === 'done' && !diffState.result.ok && (
          <div className="fs-hint fs-hint-error">
            {diffState.result.message ?? '获取 diff 失败'}
          </div>
        )}
      </div>

      {diffs.length > 0 && <SessionEdits diffs={diffs} />}
    </div>
  );
}

export function FileSystemPanel({
  diffs,
  onClose,
}: {
  readonly diffs: readonly DiffEntry[];
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
        <ChangesView diffs={diffs} />
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
