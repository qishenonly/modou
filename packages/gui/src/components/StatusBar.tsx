/**
 * 底部状态栏：模型名 / 权限模式 / 运行状态 / 当前轮次 / 累计 token。
 * 纯展示——状态由 App 层持有并传入。
 */
import type { ReactNode } from 'react';
import { PERMISSION_MODE_LABEL, type TokenTotals } from '../../electron/status';
import { formatTokens } from '../lib/format';

export function StatusBar({
  modelName,
  permissionMode,
  totals,
  running,
  turn,
}: {
  readonly modelName?: string;
  readonly permissionMode?: string;
  readonly totals: TokenTotals;
  readonly running: boolean;
  readonly turn: number;
}): ReactNode {
  return (
    <footer className="statusbar">
      {modelName !== undefined && (
        <span className="status-seg status-model">{modelName}</span>
      )}
      {permissionMode !== undefined && (
        <span className="status-seg">{permissionMode}</span>
      )}
      <span
        className={`status-seg status-dot${running ? ' status-running' : ''}`}
      >
        {running ? '● 运行中' : '○ 就绪'}
      </span>
      <span className="status-seg">turn {turn}</span>
      <span className="status-seg">
        in {formatTokens(totals.inputTokens)} / out{' '}
        {formatTokens(totals.outputTokens)}
      </span>
      {totals.cacheReadTokens > 0 && (
        <span className="status-seg">
          cache +{formatTokens(totals.cacheReadTokens)}
        </span>
      )}
    </footer>
  );
}

export { PERMISSION_MODE_LABEL };
