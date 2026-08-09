/**
 * 快照面板（0.10.0 /rewind）：快照点列表 → 选点预览差异 → 确认还原。
 * 数据：getSnapshots（列表）/ previewRewind（差异）/ rewindTo（还原）。
 * 还原是破坏性操作，确认态明确展示「将还原 N / 删除 M / 覆盖 K（手动改动）」。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { RewindPreview, SnapshotPoint } from '@modou/core';
import { formatTime } from '../lib/format';

function shortId(id: string | null): string {
  if (id === null || id.length <= 8) return id ?? '—';
  return id.slice(0, 8);
}

export function SnapshotPanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [points, setPoints] = useState<readonly SnapshotPoint[]>([]);
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.modou
      .getSnapshots()
      .then((value) => setPoints(value.filter((point) => !point.degraded)));
  }, []);

  const select = async (snapshotId: string): Promise<void> => {
    setBusy(true);
    const result = await window.modou.previewRewind(snapshotId);
    if (result !== null) setPreview(result);
    setBusy(false);
  };

  const confirm = async (): Promise<void> => {
    if (preview === null) return;
    setBusy(true);
    await window.modou.rewindTo(preview.snapshotId);
    setBusy(false);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal snapshot-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">回滚到快照（/rewind）</div>

        {preview === null ? (
          <>
            {points.length === 0 && (
              <div className="modal-hint">没有可回滚的快照点</div>
            )}
            <div className="snapshot-list">
              {points.map((point) => (
                <button
                  key={point.id ?? point.ts}
                  type="button"
                  className="snapshot-item"
                  onClick={() => {
                    if (point.id !== null) void select(point.id);
                  }}
                  disabled={busy}
                >
                  <span className="snapshot-id">{shortId(point.id)}</span>
                  <span className="snapshot-summary">{point.summary}</span>
                  <span className="snapshot-time">{formatTime(point.ts)}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="snapshot-preview">
              <p>
                还原到 <b>{shortId(preview.snapshotId)}</b>：
              </p>
              <ul>
                {preview.restoreFiles.length > 0 && (
                  <li className="snapshot-restore">
                    还原 {preview.restoreFiles.length} 个文件
                  </li>
                )}
                {preview.deleteFiles.length > 0 && (
                  <li className="snapshot-delete">
                    删除 {preview.deleteFiles.length} 个文件
                  </li>
                )}
                {preview.overwriteFiles.length > 0 && (
                  <li className="snapshot-overwrite">
                    覆盖 {preview.overwriteFiles.length}{' '}
                    个文件（含手动改动，回滚会丢失这些改动）
                  </li>
                )}
              </ul>
            </div>
            <div className="plan-actions">
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void confirm()}
                disabled={busy}
              >
                确认还原
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setPreview(null)}
                disabled={busy}
              >
                返回
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
