/**
 * 命令结果卡片（对话内展示，Claude 式）：
 * 斜杠命令（/cost /mcp /context /init /rewind /snapshots /plan）的结果
 * 以「对话内卡片」呈现——像问答一样跟在用户命令消息之后，而不是模态弹窗。
 * 每张卡片：标题 + 关闭按钮 + 内容；rewind/plan 卡片保留交互（选择/确认/裁决）。
 */
import { useState, type ReactNode } from 'react';
import type {
  ContextStateData,
  CostTotals,
  DayCostTotals,
  InitResult,
  McpServerStatus,
  RewindPreview,
  SnapshotPoint,
  SnapshotUsageReport,
  StructuredPlan,
} from '@modou/core';
import { BUILTIN_SLASH_COMMANDS } from '../../electron/slash';
import { formatTime, formatTokens } from '../lib/format';

/** 对话内卡片容器（标题 + 关闭）。 */
export function InlineCard({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="inline-card">
      <div className="inline-card-head">
        <span className="inline-card-title">{title}</span>
        <button
          type="button"
          className="inline-card-close"
          onClick={onClose}
          title="关闭"
        >
          ×
        </button>
      </div>
      <div className="inline-card-body">{children}</div>
    </div>
  );
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

/** /cost：本会话 + 按天聚合。 */
export function CostCard({
  data,
  onClose,
}: {
  readonly data: {
    readonly session: CostTotals;
    readonly days: readonly DayCostTotals[];
  };
  readonly onClose: () => void;
}): ReactNode {
  const money = (cost: CostTotals): string =>
    cost.totalCost === undefined || !cost.priced
      ? '?'
      : `¥${cost.totalCost.toFixed(4)}`;
  return (
    <InlineCard title="成本统计（/cost）" onClose={onClose}>
      <Row label="请求数" value={String(data.session.requests)} />
      <Row label="输入 token" value={formatTokens(data.session.inputTokens)} />
      <Row label="输出 token" value={formatTokens(data.session.outputTokens)} />
      <Row label="费用" value={money(data.session)} />
      <div className="cost-section-title">按天（本项目全部会话）</div>
      {data.days.length === 0 && <div className="modal-hint">暂无按天记录</div>}
      {data.days.map((day) => (
        <div key={day.day} className="cost-day">
          <span className="cost-day-key">{day.day}</span>
          <span className="cost-day-meta">
            {formatTokens(day.inputTokens + day.outputTokens)} tokens ·{' '}
            {money(day)}
          </span>
        </div>
      ))}
    </InlineCard>
  );
}

/** /mcp：服务器连接状态。 */
export function McpCard({
  data,
  onClose,
}: {
  readonly data: readonly McpServerStatus[];
  readonly onClose: () => void;
}): ReactNode {
  const stateLabel: Readonly<Record<string, string>> = {
    connecting: '连接中',
    connected: '已连接',
    disconnected: '已断开',
    failed: '失败',
  };
  return (
    <InlineCard title="MCP 服务器（/mcp）" onClose={onClose}>
      {data.length === 0 ? (
        <div className="modal-hint">
          未配置 MCP 服务器。在 settings.json 的 <code>mcp.servers</code>{' '}
          键配置后重启生效。
        </div>
      ) : (
        <div className="mcp-list">
          {data.map((server) => (
            <div key={server.name} className={`mcp-item mcp-${server.state}`}>
              <span className="mcp-dot" aria-hidden="true" />
              <span className="mcp-name">{server.name}</span>
              <span className="mcp-state">
                {stateLabel[server.state] ?? server.state}
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
    </InlineCard>
  );
}

/** /context：上下文分项核算。 */
export function ContextCard({
  data,
  onClose,
}: {
  readonly data: ContextStateData;
  readonly onClose: () => void;
}): ReactNode {
  const total = data.total;
  return (
    <InlineCard
      title={`上下文用量${data.nearCompaction === true ? ' · 接近压缩阈值' : ''}`}
      onClose={onClose}
    >
      <div className="context-body">
        {data.sections.map((section) => {
          const ratio = total > 0 ? section.tokens / total : 0;
          return (
            <div key={section.name} className="context-row">
              <div className="context-head">
                <span className="context-name">{section.name}</span>
                <span className="context-tokens">
                  {formatTokens(section.tokens)}（{Math.round(ratio * 100)}%）
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
          {data.drift.error !== 0 && (
            <span className="context-drift">
              {' '}
              · 粗估 vs 实测偏差 {formatTokens(data.drift.error)}（
              {(data.drift.rate * 100).toFixed(1)}%）
            </span>
          )}
        </div>
      </div>
    </InlineCard>
  );
}

/** /init：AGENTS.md 初稿。 */
export function InitCard({
  data,
  onClose,
}: {
  readonly data: InitResult;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <InlineCard title="生成 AGENTS.md（/init）" onClose={onClose}>
      <div className={`init-status ${data.wrote ? 'init-ok' : 'init-warn'}`}>
        {data.wrote
          ? `已写入 ${data.targetPath}`
          : `AGENTS.md 已存在（${data.targetPath}），未覆盖——请手动合并初稿。`}
      </div>
      <pre className="init-draft">{data.draft}</pre>
    </InlineCard>
  );
}

/** /snapshots：快照占用报告。 */
export function SnapshotsCard({
  data,
  onClose,
}: {
  readonly data: SnapshotUsageReport;
  readonly onClose: () => void;
}): ReactNode {
  const projects = data.projects ?? [];
  return (
    <InlineCard title="快照占用（/snapshots）" onClose={onClose}>
      {projects.length === 0 && <div className="modal-hint">暂无快照</div>}
      {projects.map((project) => (
        <div key={project.projectHash} className="cost-day">
          <span className="cost-day-key">
            {project.projectHash.slice(0, 8)}
          </span>
          <span className="cost-day-meta">
            {project.snapshotCount} 个快照 · {project.bytes} 字节
          </span>
        </div>
      ))}
    </InlineCard>
  );
}

/** /rewind：快照列表 → 选点预览差异 → 确认还原（交互保留在卡片内）。 */
export function RewindCard({
  points,
  onClose,
}: {
  readonly points: readonly SnapshotPoint[];
  readonly onClose: () => void;
}): ReactNode {
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [busy, setBusy] = useState(false);

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

  const shortId = (id: string | null): string =>
    id === null || id.length <= 8 ? (id ?? '—') : id.slice(0, 8);

  return (
    <InlineCard title="回滚到快照（/rewind）" onClose={onClose}>
      {preview === null ? (
        points.length === 0 ? (
          <div className="modal-hint">没有可回滚的快照点</div>
        ) : (
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
        )
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
                  个文件（含手动改动，回滚会丢失）
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
    </InlineCard>
  );
}

/** /help：内置斜杠命令清单。 */
export function HelpCard({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  return (
    <InlineCard title="斜杠命令（/help）" onClose={onClose}>
      <div className="help-list">
        {BUILTIN_SLASH_COMMANDS.map((command) => (
          <div key={command.name} className="help-row">
            <code className="help-usage">{command.usage}</code>
            <span className="help-desc">{command.description}</span>
          </div>
        ))}
      </div>
    </InlineCard>
  );
}

/** /plan：结构化计划五段 + 批准/修改/拒绝。 */
export function PlanCard({
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
  const Section = ({
    title,
    lines,
  }: {
    readonly title: string;
    readonly lines: readonly string[];
  }): ReactNode => {
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
  };
  return (
    <InlineCard title="实施计划" onClose={onClose}>
      <Section title="目标" lines={[plan.goal]} />
      <Section title="涉及文件" lines={plan.files} />
      <Section title="分步改动" lines={plan.steps} />
      <Section title="验证方式" lines={plan.verification} />
      <Section title="风险点" lines={plan.risks} />
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
    </InlineCard>
  );
}

// ---------------------------------------------------------------------------
// 卡片集合类型（App 维护命令结果卡片列表；ChatThread 按 kind 渲染）
// ---------------------------------------------------------------------------

/** 命令结果卡片的联合类型。 */
export type GuiCard =
  | { readonly kind: 'help' }
  | {
      readonly kind: 'cost';
      readonly data: {
        readonly session: CostTotals;
        readonly days: readonly DayCostTotals[];
      };
    }
  | { readonly kind: 'mcp'; readonly data: readonly McpServerStatus[] }
  | { readonly kind: 'context'; readonly data: ContextStateData }
  | { readonly kind: 'init'; readonly data: InitResult }
  | { readonly kind: 'snapshots'; readonly data: SnapshotUsageReport }
  | { readonly kind: 'rewind'; readonly data: readonly SnapshotPoint[] }
  | { readonly kind: 'plan'; readonly data: StructuredPlan };
