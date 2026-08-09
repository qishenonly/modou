/**
 * 子代理活动块（0.12.0 T-122）：按 agent 分组折叠展示子代理过程。
 * 主对话不被子代理的完整过程污染——只展示一条可展开的卡片：
 * 状态（运行中/完成/出错）+ 工具调用数 + 过程文本摘要。
 */
import { useState, type ReactNode } from 'react';
import type { SubagentEntry } from '../lib/state';

const STATUS_LABEL: Readonly<Record<SubagentEntry['status'], string>> = {
  running: '运行中',
  done: '完成',
  error: '出错',
};

export function SubagentBlock({
  entry,
}: {
  readonly entry: SubagentEntry;
}): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <div className={`subagent subagent-${entry.status}`}>
      <button
        type="button"
        className="subagent-head"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span className="subagent-dot" aria-hidden="true" />
        <span className="subagent-title">子代理 {entry.id.slice(0, 8)}</span>
        <span className="subagent-status">{STATUS_LABEL[entry.status]}</span>
        {entry.toolCount > 0 && (
          <span className="subagent-tools">{entry.toolCount} 次工具调用</span>
        )}
        <span className="subagent-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && entry.text.length > 0 && (
        <pre className="subagent-body">{entry.text}</pre>
      )}
    </div>
  );
}
