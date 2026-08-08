/**
 * 工具调用卡片（Claude Desktop 式）：折叠为一行摘要，展开看参数与输出。
 * Edit 结果以 diff 高亮（删除红 / 添加绿）；进行中显示实时进度文本。
 */
import { useState, type ReactNode } from 'react';
import type { ToolCallEntry } from '../lib/tools';
import {
  diffFromPayload,
  formatValue,
  markerOf,
  summarizeEntry,
  summarizeInput,
  toolLabel,
  type DiffLine,
} from '../lib/tools';

/** diff 行渲染（纯展示）。 */
function DiffView({
  lines,
}: {
  readonly lines: readonly DiffLine[];
}): ReactNode {
  return (
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
  );
}

/** 输出区：diff 优先，其次 forModel，再 payload JSON，进行中显示进度。 */
function ToolOutput({ entry }: { readonly entry: ToolCallEntry }): ReactNode {
  if (entry.status === 'pending' || entry.status === 'running') {
    if (entry.progress !== undefined && entry.progress.length > 0) {
      return <pre className="tool-output">{entry.progress}</pre>;
    }
    return <div className="tool-output tool-running">执行中…</div>;
  }
  const diff = diffFromPayload(entry.payload);
  if (diff !== null) return <DiffView lines={diff} />;
  if (entry.forModel !== undefined && entry.forModel.length > 0) {
    return <pre className="tool-output">{entry.forModel}</pre>;
  }
  if (entry.payload !== undefined) {
    return <pre className="tool-output">{formatValue(entry.payload)}</pre>;
  }
  return <div className="tool-output tool-muted">（无输出）</div>;
}

/** 入参区：JSON 美化（已由管线脱敏）。 */
function ToolInput({ entry }: { readonly entry: ToolCallEntry }): ReactNode {
  if (entry.input === undefined) return null;
  return (
    <details className="tool-input">
      <summary>参数</summary>
      <pre>{formatValue(entry.input)}</pre>
    </details>
  );
}

/** 一条工具调用卡片。 */
export function ToolCard({
  entry,
}: {
  readonly entry: ToolCallEntry;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const { marker, tone } = markerOf(entry);
  const summary =
    entry.status === 'done'
      ? summarizeEntry(entry)
      : summarizeInput(entry.name, entry.input);
  const active = entry.status === 'pending' || entry.status === 'running';

  return (
    <div
      className={`tool-card${open ? ' tool-card-open' : ''}${active ? ' tool-card-active' : ''}`}
    >
      <button
        type="button"
        className="tool-card-head"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span className={`tool-marker tool-marker-${tone}`}>{marker}</span>
        <span className="tool-name">{toolLabel(entry.name)}</span>
        <span className="tool-summary">{summary}</span>
        <span className="tool-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-card-body">
          <ToolInput entry={entry} />
          <ToolOutput entry={entry} />
        </div>
      )}
    </div>
  );
}
