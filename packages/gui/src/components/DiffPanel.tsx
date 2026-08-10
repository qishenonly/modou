/**
 * 右侧文件变更面板（Codex 式）：实时收集 Edit/Write 产生的 diff，
 * 固定显示在窗口右侧，可切换文件、查看逐行 diff（删除红 / 添加绿）。
 */
import { useState, type ReactNode } from 'react';
import { buildDiffLines } from '../lib/tools';

/** 一次文件变更（从 tool_result 的 Edit payload 提取）。 */
export interface DiffEntry {
  readonly id: string;
  readonly path?: string;
  readonly oldText: string;
  readonly newText: string;
}

export function DiffPanel({
  diffs,
  onClose,
}: {
  readonly diffs: readonly DiffEntry[];
  readonly onClose: () => void;
}): ReactNode {
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = diffs.find((diff) => diff.id === activeId) ?? diffs[0];
  if (active === undefined) return null;

  const lines = buildDiffLines(active.oldText, active.newText);

  return (
    <aside className="diff-panel">
      <div className="diff-panel-head">
        <span className="diff-panel-title">文件变更</span>
        <button type="button" className="panel-close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="diff-panel-files">
        {diffs.map((diff, index) => (
          <button
            key={diff.id}
            type="button"
            className={`diff-file${diff.id === active.id ? ' diff-file-active' : ''}`}
            onClick={() => setActiveId(diff.id)}
            title={diff.path}
          >
            {diff.path ?? `变更 ${index + 1}`}
          </button>
        ))}
      </div>
      <div className="diff-panel-body">
        <div className="diff">
          {lines.map((line, index) => (
            <div key={index} className={`diff-line diff-${line.kind}`}>
              <span className="diff-prefix">
                {line.kind === 'remove' ? '−' : line.kind === 'add' ? '+' : ' '}
              </span>
              <span className="diff-text">{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
