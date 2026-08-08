/**
 * 上下文用量面板（/context）：分项核算展示——每段占比条 + 合计 + 粗估/实测偏差。
 * 数据来自主进程 getContext（buildContextState，与 loop 同源同构）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { ContextStateData } from '@modou/core';
import { formatTokens } from '../lib/format';

export function ContextPanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [state, setState] = useState<ContextStateData | null>(null);

  useEffect(() => {
    void window.modou.getContext().then((value) => setState(value));
  }, []);

  const sections = state?.sections ?? [];
  const total = state?.total ?? 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal context-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">
          上下文用量
          {state?.nearCompaction === true && (
            <span className="context-warn"> · 接近压缩阈值</span>
          )}
        </div>
        {state === null ? (
          <div className="modal-hint">加载中…</div>
        ) : (
          <div className="context-body">
            {sections.map((section) => {
              const ratio = total > 0 ? section.tokens / total : 0;
              return (
                <div key={section.name} className="context-row">
                  <div className="context-head">
                    <span className="context-name">{section.name}</span>
                    <span className="context-tokens">
                      {formatTokens(section.tokens)}（{Math.round(ratio * 100)}
                      %）
                    </span>
                  </div>
                  <div className="context-bar">
                    <div
                      className="context-fill"
                      style={{ width: `${Math.min(100, ratio * 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
            <div className="context-total">
              合计：{formatTokens(total)} tokens
              {state.drift.error !== 0 && (
                <span className="context-drift">
                  {' '}
                  · 粗估 vs 实测偏差 {formatTokens(state.drift.error)}（
                  {(state.drift.rate * 100).toFixed(1)}%）
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
