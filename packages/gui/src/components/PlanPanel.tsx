/**
 * 计划面板（0.11.0 T-112 Plan Mode）：展示结构化计划五段，三按钮裁决——
 * 批准（plan_approve）/ 修改（plan_modify）/ 拒绝（plan_reject）。
 * 计划数据来自 PLAN 通道 / GET_PLAN（bridge 在计划轮结束后解析模型输出）。
 */
import type { ReactNode } from 'react';
import type { StructuredPlan } from '@modou/core';

function Section({
  title,
  lines,
}: {
  readonly title: string;
  readonly lines: readonly string[];
}): ReactNode {
  if (lines.length === 0) return null;
  return (
    <div className="plan-section">
      <div className="plan-section-title">{title}</div>
      <ul className="plan-section-lines">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

export function PlanPanel({
  plan,
  onApprove,
  onModify,
  onReject,
  onClose,
}: {
  readonly plan: StructuredPlan;
  readonly onApprove: () => void;
  readonly onModify: () => void;
  readonly onReject: () => void;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal plan-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">实施计划</div>
        <div className="plan-body">
          <Section title="目标" lines={[plan.goal]} />
          <Section title="涉及文件" lines={plan.files} />
          <Section title="分步改动" lines={plan.steps} />
          <Section title="验证方式" lines={plan.verification} />
          <Section title="风险点" lines={plan.risks} />
        </div>
        <div className="plan-actions">
          <button type="button" className="btn btn-primary" onClick={onApprove}>
            批准并执行
          </button>
          <button type="button" className="btn btn-ghost" onClick={onModify}>
            修改
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-danger"
            onClick={onReject}
          >
            拒绝
          </button>
        </div>
        <div className="modal-hint">
          批准后按计划实施；修改保留计划模式继续研究；拒绝零改动
        </div>
      </div>
    </div>
  );
}
