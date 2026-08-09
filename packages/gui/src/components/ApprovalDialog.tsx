/**
 * 审批请求（Claude Desktop / Codex 式内联条）：
 * 展示在输入框上方，不弹模态。待执行操作 + 风险级别 + 三选项裁决
 * （本次允许 / 始终允许 / 拒绝），键盘可操作。
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type {
  ApprovalDecision,
  ApprovalRequestData,
  RiskLevel,
} from '@modou/core';

const RISK_LABEL: Readonly<Record<RiskLevel, string>> = {
  read: '读取',
  write: '写入',
  exec: '执行',
  network: '网络',
};

const OPTION_TONE: Readonly<Record<ApprovalDecision, string>> = {
  allow_once: 'allow',
  allow_always: 'allow-strong',
  deny: 'deny',
};

export function ApprovalDialog({
  request,
  onApprove,
}: {
  readonly request: ApprovalRequestData;
  readonly onApprove: (requestId: string, decision: ApprovalDecision) => void;
}): ReactNode {
  const [focus, setFocus] = useState(0);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      onApprove(request.id, 'deny');
      return;
    }
    const index = Number(event.key);
    if (index >= 1 && index <= request.options.length) {
      onApprove(request.id, request.options[index - 1].id);
      return;
    }
    if (event.key === 'Enter') {
      const option = request.options[focus];
      if (option !== undefined) onApprove(request.id, option.id);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      setFocus(
        (prev) =>
          (prev +
            (event.key === 'ArrowDown' ? 1 : -1) +
            request.options.length) %
          request.options.length,
      );
    }
  };

  return (
    <div
      className="approval-inline"
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="false"
    >
      <div className="approval-inline-head">
        <span className="risk-badge">
          审批 · 风险：{RISK_LABEL[request.risk] ?? request.risk}
        </span>
        <span className="approval-inline-hint">Esc 拒绝</span>
      </div>
      <pre className="approval-desc">{request.description}</pre>
      <div className="approval-options">
        {request.options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            className={`btn btn-approval btn-${OPTION_TONE[option.id] ?? 'allow'}${index === focus ? ' btn-focus' : ''}`}
            onClick={() => onApprove(request.id, option.id)}
            onMouseEnter={() => setFocus(index)}
          >
            <span className="btn-num">{index + 1}</span> {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
