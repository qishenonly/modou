/**
 * /init 面板（0.13.0 T-132）：分析仓库结构 → AGENTS.md 初稿预览 + 写入结果。
 * 已存在时不覆盖（wrote=false），提示手动合并。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { InitResult } from '@modou/core';

export function InitPanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [result, setResult] = useState<InitResult | null>(null);

  useEffect(() => {
    void window.modou.planInit().then((value) => setResult(value));
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal init-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">生成 AGENTS.md（/init）</div>
        {result === null ? (
          <div className="modal-hint">探测中…</div>
        ) : (
          <div className="init-body">
            <div
              className={`init-status ${result.wrote ? 'init-ok' : 'init-warn'}`}
            >
              {result.wrote
                ? `已写入 ${result.targetPath}`
                : `AGENTS.md 已存在（${result.targetPath}），未覆盖——请手动合并初稿。`}
            </div>
            <pre className="init-draft">{result.draft}</pre>
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
