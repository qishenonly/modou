/**
 * 底部细状态栏：模型 / 权限模式 / 运行状态 / 当前轮次 / 累计 token。
 * Claude Desktop 没有状态栏，这里是 modou 的最小信息条（细、弱化）。
 */
import type { ReactNode } from 'react';
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
  readonly totals: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
  };
  readonly running: boolean;
  readonly turn: number;
}): ReactNode {
  const segments: string[] = [];
  if (modelName !== undefined) segments.push(modelName);
  if (permissionMode !== undefined) segments.push(permissionMode);
  segments.push(running ? '运行中' : '就绪');
  segments.push(`turn ${turn}`);
  segments.push(
    `in ${formatTokens(totals.inputTokens)} / out ${formatTokens(totals.outputTokens)}`,
  );
  if (totals.cacheReadTokens > 0) {
    segments.push(`cache +${formatTokens(totals.cacheReadTokens)}`);
  }
  return (
    <footer className="statusbar">
      <span className={`status-dot${running ? ' status-running' : ''}`}>
        {running ? '●' : '○'}
      </span>
      <span>{segments.join(' · ')}</span>
    </footer>
  );
}
