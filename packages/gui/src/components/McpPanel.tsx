/**
 * MCP 状态面板（0.16.0 /mcp）：各服务器连接状态 / 传输 / 工具数 / 错误。
 * 未配置服务器时明确说明（不静默）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { McpServerStatus } from '@modou/core';

const STATE_LABEL: Readonly<Record<string, string>> = {
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  failed: '失败',
};

export function McpPanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [statuses, setStatuses] = useState<readonly McpServerStatus[]>([]);

  useEffect(() => {
    void window.modou.getMcpStatus().then((value) => setStatuses(value));
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal mcp-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">MCP 服务器（/mcp）</div>
        {statuses.length === 0 ? (
          <div className="modal-hint">
            未配置 MCP 服务器。在 settings.json 的 <code>mcp.servers</code>{' '}
            键配置后重启生效。
          </div>
        ) : (
          <div className="mcp-list">
            {statuses.map((server) => (
              <div key={server.name} className={`mcp-item mcp-${server.state}`}>
                <span className="mcp-dot" aria-hidden="true" />
                <span className="mcp-name">{server.name}</span>
                <span className="mcp-state">
                  {STATE_LABEL[server.state] ?? server.state}
                </span>
                <span className="mcp-meta">
                  {server.transport} · {server.toolCount} 工具
                  {server.serverInfo?.name !== undefined
                    ? ` · ${server.serverInfo.name}`
                    : ''}
                </span>
                {server.error !== undefined && (
                  <span className="mcp-error" title={server.error}>
                    {server.error}
                  </span>
                )}
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
