/**
 * 成本面板（0.13.0 /cost）：本会话 + 本项目按天聚合（token / 费用）。
 * 未知模型只报 token、费用标 '?'（绝不假装知道价格）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { CostTotals, DayCostTotals } from '@modou/core';
import { formatTokens } from '../lib/format';

function money(cost: CostTotals): string {
  if (cost.totalCost === undefined || !cost.priced) return '?';
  return `¥${cost.totalCost.toFixed(4)}`;
}

function Row({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="settings-row">
      <div className="settings-label">{label}</div>
      <div className="settings-value">{value}</div>
    </div>
  );
}

export function CostPanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [data, setData] = useState<{
    readonly session: CostTotals;
    readonly days: readonly DayCostTotals[];
  } | null>(null);

  useEffect(() => {
    void window.modou.getCost().then((value) => setData(value));
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal cost-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">成本统计（/cost）</div>
        {data === null ? (
          <div className="modal-hint">加载中…（尚无会话时为空）</div>
        ) : (
          <div className="cost-body">
            <div className="cost-section-title">本会话</div>
            <Row label="请求数" value={String(data.session.requests)} />
            <Row
              label="输入 token"
              value={formatTokens(data.session.inputTokens)}
            />
            <Row
              label="输出 token"
              value={formatTokens(data.session.outputTokens)}
            />
            <Row label="费用" value={money(data.session)} />

            <div className="cost-section-title">按天（本项目全部会话）</div>
            {data.days.length === 0 && (
              <div className="modal-hint">暂无按天记录</div>
            )}
            {data.days.map((day) => (
              <div key={day.day} className="cost-day">
                <span className="cost-day-key">{day.day}</span>
                <span className="cost-day-meta">
                  {formatTokens(day.inputTokens + day.outputTokens)} tokens ·{' '}
                  {money(day)}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
