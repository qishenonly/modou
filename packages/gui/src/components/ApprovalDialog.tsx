/**
 * 审批弹窗（Claude Desktop 式模态）：展示待执行操作与风险级别，三选项裁决
 * （allow_once / allow_always / deny）。裁决经 App 层转成 `approve` Command。
 * 危险命令由 core 强制逐次确认，可选项只透传 core 给的（不自己补全）。
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

/** 选项 → 按钮标签（core 已给 label，这里只补主按钮文案）。 */
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

  // Esc / 快捷键
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
      className="modal-backdrop"
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
    >
      <div className="modal approval-dialog">
        <div className="modal-title">⚠ 审批请求</div>
        <div className="approval-risk">
          <span className="risk-badge">
            风险：{RISK_LABEL[request.risk] ?? request.risk}
          </span>
        </div>
        <pre className="approval-desc">{request.description}</pre>
        <div className="approval-options">
          {request.options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              className={`btn btn-${OPTION_TONE[option.id] ?? 'allow'}${index === focus ? ' btn-focus' : ''}`}
              onClick={() => onApprove(request.id, option.id)}
              onMouseEnter={() => setFocus(index)}
            >
              <span className="btn-num">{index + 1}</span> {option.label}
            </button>
          ))}
        </div>
        <div className="modal-hint">数字键选择 · Enter 确认 · Esc 拒绝</div>
      </div>
    </div>
  );
}
