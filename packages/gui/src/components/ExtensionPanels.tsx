/**
 * 扩展功能独立面板（Claude Desktop 式独立管理页）：
 * MCP / Hooks / Skills / Agents 各自一个页面，从侧栏「扩展」区进入。
 * 每个面板自包含数据拉取与编辑，保存统一写入 settings.json（重建 bridge 生效）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { McpServerStatus } from '@modou/core';
import type { GuiSettings, GuiSettingsPatch } from '../../electron/ipc';

/** 全屏面板容器（标题 + 关闭 + 内容）。 */
export function ExtensionPanel({
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

/** 一个「保存」动作条（有改动时显示保存按钮 + 提示）。 */
function SaveBar({
  dirty,
  saving,
  note,
  onSave,
}: {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly note: string | null;
  readonly onSave: () => void;
}): ReactNode {
  if (!dirty && note === null) return null;
  return (
    <div className="panel-savebar">
      {note !== null && <span className="settings-note">{note}</span>}
      {dirty && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      )}
    </div>
  );
}

function hooksToRecord(
  list: readonly { readonly point: string; readonly command: string }[],
): Record<string, readonly { readonly command: string }[]> {
  const record: Record<string, readonly { readonly command: string }[]> = {};
  for (const hook of list) {
    record[hook.point] = [
      ...(record[hook.point] ?? []),
      { command: hook.command },
    ];
  }
  return record;
}

const HOOK_POINTS: readonly string[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
];

const MCP_RISKS: readonly { readonly value: string; readonly label: string }[] =
  [
    { value: 'network', label: '网络（默认）' },
    { value: 'read', label: '读取' },
    { value: 'write', label: '写入' },
    { value: 'exec', label: '执行' },
  ];

// ---------------------------------------------------------------------------
// MCP 面板：服务器连接状态 + 配置管理
// ---------------------------------------------------------------------------

export function McpPanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [status, setStatus] = useState<readonly McpServerStatus[]>([]);
  const [settings, setSettings] = useState<GuiSettings | null>(null);
  const [draft, setDraft] = useState<GuiSettingsPatch>({});
  const [name, setName] = useState('');
  const [cmd, setCmd] = useState('');
  const [risk, setRisk] = useState('network');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void window.modou.getMcpStatus().then((value) => setStatus(value));
    void window.modou.getSettings().then((value) => setSettings(value ?? null));
  }, []);

  const list = draft.mcpServers ?? settings?.mcpServers ?? [];
  const dirty = draft.mcpServers !== undefined;

  const save = async (): Promise<void> => {
    setSaving(true);
    const result = await window.modou.saveSettings(draft);
    setNote(
      result.ok
        ? '已保存并应用（MCP 服务器已重新连接）。'
        : (result.message ?? '保存失败'),
    );
    setDraft({});
    setSaving(false);
    // 刷新连接状态
    void window.modou.getMcpStatus().then((value) => setStatus(value));
  };

  return (
    <ExtensionPanel title="MCP 服务器" onClose={onClose}>
      {settings === null ? (
        <div className="modal-hint">加载中…</div>
      ) : (
        <>
          <div className="panel-section-title">连接状态</div>
          {status.length === 0 ? (
            <p className="settings-desc">
              未配置服务器；在下方添加（stdio 命令或 HTTP URL）。
            </p>
          ) : (
            <div className="mcp-list">
              {status.map((server) => (
                <div
                  key={server.name}
                  className={`mcp-item mcp-${server.state}`}
                >
                  <span className="mcp-dot" aria-hidden="true" />
                  <span className="mcp-name">{server.name}</span>
                  <span className="mcp-state">
                    {server.state === 'connected'
                      ? '已连接'
                      : server.state === 'connecting'
                        ? '连接中'
                        : server.state === 'disconnected'
                          ? '已断开'
                          : '失败'}
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

          <div className="panel-section-title">服务器配置</div>
          {list.length === 0 ? (
            <p className="settings-desc">还没有服务器。</p>
          ) : (
            <div className="hook-list">
              {list.map((server) => (
                <div key={server.name} className="hook-item">
                  <span className="hook-point">{server.name}</span>
                  <span className="hook-count">
                    {server.command !== undefined ? 'stdio' : 'http'} ·{' '}
                    {server.enabled !== false ? '启用' : '停用'} ·{' '}
                    {server.command ?? server.url ?? ''}
                  </span>
                  <button
                    type="button"
                    className="rule-remove"
                    title="删除服务器"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        mcpServers: list.filter((s) => s.name !== server.name),
                      }))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="rule-add">
            <input
              className="input"
              placeholder="名称，如 filesystem"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <input
              className="input"
              placeholder="命令 或 http://URL"
              value={cmd}
              onChange={(event) => setCmd(event.target.value)}
            />
            <select
              className="select"
              value={risk}
              onChange={(event) => setRisk(event.target.value)}
            >
              {MCP_RISKS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={name.trim().length === 0 || cmd.trim().length === 0}
              onClick={() => {
                const target = cmd.trim();
                const isUrl = /^https?:\/\//.test(target);
                setDraft((prev) => ({
                  ...prev,
                  mcpServers: [
                    ...list,
                    {
                      name: name.trim(),
                      ...(isUrl ? { url: target } : { command: target }),
                      enabled: true,
                      risk,
                    },
                  ],
                }));
                setName('');
                setCmd('');
              }}
            >
              添加
            </button>
          </div>
          <p className="settings-desc">
            保存后重建会话并重新连接；MCP 工具走同一权限管线（risk 默认 network
            需审批）。
          </p>
        </>
      )}
      <SaveBar
        dirty={dirty}
        saving={saving}
        note={note}
        onSave={() => void save()}
      />
    </ExtensionPanel>
  );
}

// ---------------------------------------------------------------------------
// Hooks 面板：生命周期钩子管理
// ---------------------------------------------------------------------------

export function HooksPanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [settings, setSettings] = useState<GuiSettings | null>(null);
  const [draft, setDraft] = useState<GuiSettingsPatch>({});
  const [point, setPoint] = useState('PreToolUse');
  const [cmd, setCmd] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void window.modou.getSettings().then((value) => setSettings(value ?? null));
  }, []);

  const list =
    draft.hooks !== undefined
      ? Object.entries(draft.hooks).flatMap(([p, entries]) =>
          entries.map((entry) => ({ point: p, command: entry.command })),
        )
      : (settings?.hooks ?? []);
  const dirty = draft.hooks !== undefined;

  const save = async (): Promise<void> => {
    setSaving(true);
    const result = await window.modou.saveSettings(draft);
    setNote(
      result.ok
        ? '已保存并应用（钩子已重新装配）。'
        : (result.message ?? '保存失败'),
    );
    setDraft({});
    setSaving(false);
  };

  return (
    <ExtensionPanel title="Hooks" onClose={onClose}>
      {settings === null ? (
        <div className="modal-hint">加载中…</div>
      ) : (
        <>
          <p className="settings-desc">
            生命周期钩子：在指定点执行外部命令（可拦截 /
            改写工具调用）。四个点： SessionStart / UserPromptSubmit /
            PreToolUse / PostToolUse。
          </p>
          <div className="panel-section-title">钩子列表</div>
          {list.length === 0 ? (
            <p className="settings-desc">还没有钩子。</p>
          ) : (
            <div className="hook-list">
              {list.map((hook, index) => (
                <div key={`${hook.point}-${index}`} className="hook-item">
                  <span className="hook-point">{hook.point}</span>
                  <span className="hook-count">{hook.command}</span>
                  <button
                    type="button"
                    className="rule-remove"
                    title="删除钩子"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        hooks: hooksToRecord(
                          list.filter((_, i) => i !== index),
                        ),
                      }))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="rule-add">
            <select
              className="select"
              value={point}
              onChange={(event) => setPoint(event.target.value)}
            >
              {HOOK_POINTS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              className="input"
              placeholder="命令，如 ./scripts/check.sh"
              value={cmd}
              onChange={(event) => setCmd(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={cmd.trim().length === 0}
              onClick={() => {
                setDraft((prev) => ({
                  ...prev,
                  hooks: hooksToRecord([
                    ...list,
                    { point, command: cmd.trim() },
                  ]),
                }));
                setCmd('');
              }}
            >
              添加
            </button>
          </div>
          <p className="settings-desc">
            保存后重建会话；失败降级策略在 settings.json 的 hooks
            条目里可进一步配置。
          </p>
        </>
      )}
      <SaveBar
        dirty={dirty}
        saving={saving}
        note={note}
        onSave={() => void save()}
      />
    </ExtensionPanel>
  );
}

// ---------------------------------------------------------------------------
// Skills 面板：技能清单（发现内容，只读 + 引导）
// ---------------------------------------------------------------------------

export function SkillsPanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [skills, setSkills] = useState<
    readonly { readonly name: string; readonly description: string }[]
  >([]);

  useEffect(() => {
    void window.modou.listSkills().then((value) => setSkills(value));
  }, []);

  return (
    <ExtensionPanel title="Skills" onClose={onClose}>
      <p className="settings-desc">
        技能 = SKILL.md 开放标准：name + description 常驻上下文，正文按需由
        skill 工具加载。 三级发现：内置 skills/ &lt; 全局 ~/.modou/skills/ &lt;
        项目 .modou/skills/（项目覆盖全局）。
      </p>
      <div className="panel-section-title">已发现技能</div>
      {skills.length === 0 ? (
        <p className="settings-desc">
          未发现技能。在项目 <code>.modou/skills/&lt;name&gt;/SKILL.md</code>{' '}
          添加（或全局 <code>~/.modou/skills/</code>）。
        </p>
      ) : (
        <div className="skill-list">
          {skills.map((skill) => (
            <div key={skill.name} className="skill-item">
              <span className="skill-name">{skill.name}</span>
              <span className="skill-desc">{skill.description}</span>
            </div>
          ))}
        </div>
      )}
    </ExtensionPanel>
  );
}

// ---------------------------------------------------------------------------
// Agents 面板：自定义角色清单（发现内容，只读 + 引导）
// ---------------------------------------------------------------------------

export function AgentsPanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const [agents, setAgents] = useState<
    readonly { readonly name: string; readonly description: string }[]
  >([]);

  useEffect(() => {
    void window.modou.getSettings().then((value) => {
      if (value !== null) setAgents(value.agents);
    });
  }, []);

  return (
    <ExtensionPanel title="自定义 agents" onClose={onClose}>
      <p className="settings-desc">
        角色定义：<code>.modou/agents/&lt;name&gt;.md</code>（prompt /
        allowedTools / model）。 模型据清单调 agent
        工具按名派发角色化子代理（白名单强制、一层深）。
      </p>
      <div className="panel-section-title">已发现角色</div>
      {agents.length === 0 ? (
        <p className="settings-desc">
          未发现角色。在项目 <code>.modou/agents/</code> 添加{' '}
          <code>&lt;name&gt;.md</code> （frontmatter + 角色提示词）。
        </p>
      ) : (
        <div className="skill-list">
          {agents.map((agent) => (
            <div key={agent.name} className="skill-item">
              <span className="skill-name">{agent.name}</span>
              <span className="skill-desc">{agent.description}</span>
            </div>
          ))}
        </div>
      )}
    </ExtensionPanel>
  );
}
