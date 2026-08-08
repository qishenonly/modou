/**
 * 会话选择器（模态）：/resume 的列表形态（与侧栏数据同源），
 * 点击即恢复（发送 /resume <id>）。
 */
import type { ReactNode } from 'react';
import type { ResumeCandidate } from '@modou/core';
import { formatTime } from '../lib/format';

export function ResumePicker({
  sessions,
  onSelect,
  onClose,
}: {
  readonly sessions: readonly ResumeCandidate[];
  readonly onSelect: (sessionId: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal picker"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">恢复会话</div>
        <div className="picker-list">
          {sessions.length === 0 && (
            <div className="modal-hint">没有可恢复的会话</div>
          )}
          {sessions.map((session) => (
            <button
              key={session.sessionId}
              type="button"
              className="picker-item picker-session"
              onClick={() => onSelect(session.sessionId)}
            >
              <span className="picker-main">
                {session.preview || '（空会话）'}
              </span>
              <span className="picker-meta">
                {formatTime(session.lastTs)} · {session.entryCount} 条
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
