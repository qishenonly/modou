/**
 * 侧栏功能面板：定时任务 / 查看用量。
 * 两者都是全屏模态（panel-backdrop + panel）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { CostTotals, DayCostTotals } from '@modou/core';
import type { ScheduledTask } from '../../electron/ipc';
import { formatTokens } from '../lib/format';

/** 全屏面板容器（复用扩展面板样式）。 */
export function UtilityPanel({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="panel-backdrop">
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">{title}</span>
          <button type="button" className="panel-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="panel-body">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 定时任务
// ---------------------------------------------------------------------------

export function TasksPanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [tasks, setTasks] = useState<readonly ScheduledTask[]>([]);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void window.modou.getTasks().then((value) => setTasks(value));
  }, []);

  const save = (next: readonly ScheduledTask[]): void => {
    setTasks(next);
    void window.modou.saveTasks(next);
    setNote('已保存。');
  };

  const add = (): void => {
    if (name.trim().length === 0 || prompt.trim().length === 0) return;
    save([
      ...tasks,
      {
        id: crypto.randomUUID(),
        name: name.trim(),
        prompt: prompt.trim(),
        cron: cron.trim() || '0 9 * * *',
        enabled: true,
      },
    ]);
    setName('');
    setPrompt('');
  };

  const toggle = (id: string): void => {
    save(
      tasks.map((task) =>
        task.id === id ? { ...task, enabled: !task.enabled } : task,
      ),
    );
  };

  const presets: readonly { readonly value: string; readonly label: string }[] =
    [
      { value: '0 9 * * *', label: '每天 9:00' },
      { value: '0 9 * * 1', label: '每周一 9:00' },
      { value: '0 9 * * 1-5', label: '工作日 9:00' },
      { value: 'custom', label: '自定义…' },
    ];

  return (
    <UtilityPanel title="定时任务" onClose={onClose}>
      <p className="settings-desc">
        按 cron 表达式在指定时间自动向 agent 提交提示词执行（cron 5
        段，本地时区； 如 <code>0 9 * * *</code> = 每天
        9:00）。任务在应用运行期间调度执行。
      </p>
      <div className="panel-section-title">任务列表</div>
      {tasks.length === 0 ? (
        <p className="settings-desc">还没有定时任务；下方新建一个。</p>
      ) : (
        <div className="hook-list">
          {tasks.map((task) => (
            <div key={task.id} className="hook-item">
              <span className="hook-point">{task.name}</span>
              <span className="hook-count">{task.cron}</span>
              <button
                type="button"
                className={`task-toggle${task.enabled ? ' task-toggle-on' : ''}`}
                title={task.enabled ? '点击停用' : '点击启用'}
                onClick={() => toggle(task.id)}
              >
                <span className="task-toggle-dot" />
              </button>
              <button
                type="button"
                className="rule-remove"
                title="删除任务"
                onClick={() => save(tasks.filter((t) => t.id !== task.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="panel-section-title">新建任务</div>
      <div className="settings-field">
        <label className="settings-label">名称</label>
        <input
          className="input"
          placeholder="如：每日项目摘要"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="settings-field">
        <label className="settings-label">提示词</label>
        <textarea
          className="input agent-editor"
          rows={4}
          placeholder="要交给 agent 执行的任务提示词"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </div>
      <div className="settings-field">
        <label className="settings-label">调度</label>
        <div className="rule-add">
          <select
            className="select"
            value={presets.some((p) => p.value === cron) ? cron : 'custom'}
            onChange={(event) => {
              if (event.target.value !== 'custom') setCron(event.target.value);
            }}
          >
            {presets.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="cron（分 时 日 月 周）"
            value={cron}
            onChange={(event) => setCron(event.target.value)}
          />
        </div>
        <p className="settings-desc">
          cron 5 段：分钟 小时 日 月 周（本地时区）。
        </p>
      </div>
      <div className="panel-savebar">
        {note !== null && <span className="settings-note">{note}</span>}
        <button
          type="button"
          className="btn btn-primary"
          disabled={name.trim().length === 0 || prompt.trim().length === 0}
          onClick={add}
        >
          添加任务
        </button>
      </div>
    </UtilityPanel>
  );
}

// ---------------------------------------------------------------------------
// 查看用量
// ---------------------------------------------------------------------------

function money(cost: CostTotals): string {
  return cost.totalCost === undefined || !cost.priced
    ? '?'
    : `¥${cost.totalCost.toFixed(4)}`;
}

export function UsagePanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [cost, setCost] = useState<{
    readonly session: CostTotals;
    readonly days: readonly DayCostTotals[];
  } | null>(null);
  const [modelName, setModelName] = useState('');
  const [chartMode, setChartMode] = useState<'token' | 'cost'>('token');

  useEffect(() => {
    void window.modou.getCost().then((value) => setCost(value));
    void window.modou.getConfig().then((value) => {
      if (value !== null) setModelName(value.modelName);
    });
  }, []);

  const days = cost?.days ?? [];
  const recent = days.slice(-14);
  const maxVal = Math.max(
    1,
    ...recent.map((day) =>
      chartMode === 'token'
        ? day.inputTokens + day.outputTokens
        : (day.totalCost ?? 0),
    ),
  );

  return (
    <UtilityPanel title="用量" onClose={onClose}>
      {cost === null ? (
        <div className="modal-hint">
          尚无会话数据（先发起一轮对话后再查看——用量来自会话日志）。
        </div>
      ) : (
        <>
          <div className="panel-section-title">
            本会话（{modelName || '当前模型'}）
          </div>
          <div className="settings-row">
            <span className="settings-label">请求数</span>
            <span className="settings-value">{cost.session.requests}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">输入 token</span>
            <span className="settings-value">
              {formatTokens(cost.session.inputTokens)}
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-label">输出 token</span>
            <span className="settings-value">
              {formatTokens(cost.session.outputTokens)}
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-label">费用</span>
            <span className="settings-value">{money(cost.session)}</span>
          </div>

          <div className="panel-section-title">按天（本项目全部会话）</div>
          <div className="usage-chart-head">
            <div className="usage-chart-toggle">
              {(['token', 'cost'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`usage-chart-btn${chartMode === mode ? ' usage-chart-btn-active' : ''}`}
                  onClick={() => setChartMode(mode)}
                >
                  {mode === 'token' ? 'Token' : '费用'}
                </button>
              ))}
            </div>
          </div>
          {recent.length === 0 ? (
            <p className="settings-desc">暂无按天记录。</p>
          ) : (
            <div className="usage-chart">
              {recent.map((day) => {
                const value =
                  chartMode === 'token'
                    ? day.inputTokens + day.outputTokens
                    : (day.totalCost ?? 0);
                const pct = Math.max(2, Math.round((value / maxVal) * 100));
                return (
                  <div
                    key={day.day}
                    className="usage-bar-col"
                    title={`${day.day}：${formatTokens(day.inputTokens + day.outputTokens)} tokens · ${money(day)}`}
                  >
                    <div className="usage-bar">
                      <div
                        className="usage-bar-fill"
                        style={{ height: `${pct}%` }}
                      />
                    </div>
                    <span className="usage-bar-label">{day.day.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="panel-section-title">按天明细</div>
          {days.length === 0 ? (
            <p className="settings-desc">暂无按天记录。</p>
          ) : (
            <div className="cost-list">
              {days.map((day) => (
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
        </>
      )}
    </UtilityPanel>
  );
}
