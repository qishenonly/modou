/**
 * 扩展功能内容组件（融合进设置面板的分类页）：
 * MCP / Hooks / Skills / Agents 各自是设置里的一个分类，内容自包含
 * 数据拉取与编辑（保存统一写入 settings.json 或 agent 文件，重建生效）。
 * 不带独立面板外壳——由 SettingsPanel 的分类导航承载。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { McpServerStatus } from '@modou/core';
import type { GuiSettings, GuiSettingsPatch } from '../../electron/ipc';

/** 一个「保存」动作条（有改动时显示保存按钮 + 提示）。 */
export function SaveBar({
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
// MCP 内容：服务器连接状态 + 配置管理
// ---------------------------------------------------------------------------

export function McpContent(): ReactNode {
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
    void window.modou.getMcpStatus().then((value) => setStatus(value));
  };

  return (
    <div className="ext-content">
      <p className="settings-desc">
        MCP 服务器走同一权限管线（risk 缺省 network
        需审批）；可加命令（stdio）或 HTTP URL，支持风险级别。
      </p>
      <div className="panel-section-title">连接状态</div>
      {status.length === 0 ? (
        <p className="settings-desc">
          未配置服务器；在下方添加（stdio 命令或 HTTP URL）。
        </p>
      ) : (
        <div className="mcp-list">
          {status.map((server) => (
            <div key={server.name} className={`mcp-item mcp-${server.state}`}>
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
      <SaveBar
        dirty={dirty}
        saving={saving}
        note={note}
        onSave={() => void save()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hooks 内容：生命周期钩子管理
// ---------------------------------------------------------------------------

export function HooksContent(): ReactNode {
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
    <div className="ext-content">
      <p className="settings-desc">
        生命周期钩子：在指定点执行外部命令（可拦截 / 改写工具调用）。四个点：
        SessionStart / UserPromptSubmit / PreToolUse / PostToolUse。
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
                    hooks: hooksToRecord(list.filter((_, i) => i !== index)),
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
              hooks: hooksToRecord([...list, { point, command: cmd.trim() }]),
            }));
            setCmd('');
          }}
        >
          添加
        </button>
      </div>
      <p className="settings-desc">
        保存后重建会话；失败降级策略可在 settings.json 的 hooks
        条目里进一步配置。
      </p>
      <SaveBar
        dirty={dirty}
        saving={saving}
        note={note}
        onSave={() => void save()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills 内容：技能清单 + 额外目录
// ---------------------------------------------------------------------------

export function SkillsContent(): ReactNode {
  const [skills, setSkills] = useState<
    readonly { readonly name: string; readonly description: string }[]
  >([]);
  const [dirs, setDirs] = useState<readonly string[]>([]);
  const [newDir, setNewDir] = useState('');
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void window.modou.listSkills().then((value) => setSkills(value));
    void window.modou.getSkillDirs().then((value) => setDirs(value));
  }, []);

  const commitDirs = (next: readonly string[]): void => {
    setDirs(next);
    window.modou.setSkillDirs(next);
    setNote('已保存并应用（技能已重新发现）。');
    void window.modou.listSkills().then((value) => setSkills(value));
  };

  return (
    <div className="ext-content">
      <p className="settings-desc">
        技能 = SKILL.md 开放标准：name + description 常驻上下文，正文按需由
        skill 工具加载。 默认自动扫描：内置 skills/、全局
        ~/.modou/skills/、~/.claude/skills/、项目 .modou/skills/。
      </p>
      <div className="panel-section-title">额外技能目录</div>
      {dirs.length === 0 ? (
        <p className="settings-desc">
          还没有额外目录（输入绝对路径添加，如团队共享的技能仓库）。
        </p>
      ) : (
        <div className="hook-list">
          {dirs.map((dir) => (
            <div key={dir} className="hook-item">
              <span className="hook-point">{dir}</span>
              <button
                type="button"
                className="rule-remove"
                title="移除目录"
                onClick={() => commitDirs(dirs.filter((d) => d !== dir))}
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
          placeholder="绝对路径，如 /path/to/skills"
          value={newDir}
          onChange={(event) => setNewDir(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-ghost"
          disabled={newDir.trim().length === 0}
          onClick={() => {
            commitDirs([...dirs, newDir.trim()]);
            setNewDir('');
          }}
        >
          添加
        </button>
      </div>
      {note !== null && <p className="settings-desc">{note}</p>}

      <div className="panel-section-title">已发现技能</div>
      {skills.length === 0 ? (
        <p className="settings-desc">未发现技能。</p>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agents 内容：自定义角色（可直接创建 / 编辑 / 删除）
// ---------------------------------------------------------------------------

export function AgentsContent(): ReactNode {
  const [agents, setAgents] = useState<
    readonly { readonly name: string; readonly description: string }[]
  >([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [newName, setNewName] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const refresh = (): void => {
    void window.modou.getSettings().then((value) => {
      if (value !== null) setAgents(value.agents);
    });
  };
  useEffect(() => {
    refresh();
  }, []);

  const select = (name: string): void => {
    setSelected(name);
    void window.modou.readAgent(name).then((text) => setContent(text ?? ''));
  };

  const agentTemplate = (name: string): string =>
    `---\nname: ${name}\ndescription: 角色描述（一句话，模型据此判断何时派发）\n---\n\n这里是角色提示词。用 markdown 描述该角色的职责、行为准则与擅长场景。\n`;

  const createNew = (): void => {
    const name = newName.trim();
    if (name.length === 0) return;
    setNewName('');
    setSelected(name);
    setContent(agentTemplate(name));
    setNote(null);
  };

  const save = async (): Promise<void> => {
    if (selected === null) return;
    const ok = await window.modou.writeAgent(selected, content);
    setNote(
      ok
        ? '已保存并应用（角色已重新加载）。'
        : '保存失败（名称或内容不合法）。',
    );
    refresh();
  };

  const remove = async (name: string): Promise<void> => {
    const ok = await window.modou.deleteAgent(name);
    if (ok) {
      if (selected === name) {
        setSelected(null);
        setContent('');
      }
      refresh();
    }
  };

  return (
    <div className="ext-content">
      <p className="settings-desc">
        角色 = `.modou/agents/&lt;name&gt;.md`（frontmatter：name / description
        / allowedTools / model + 正文角色提示词）。模型据清单调 agent
        工具按名派发角色化子代理。
      </p>
      <div className="panel-section-title">角色列表</div>
      <div className="hook-list">
        {agents.map((agent) => (
          <div
            key={agent.name}
            className={`agent-row${selected === agent.name ? ' agent-row-active' : ''}`}
          >
            <button
              type="button"
              className="agent-select"
              onClick={() => select(agent.name)}
            >
              <span className="agent-name">{agent.name}</span>
              <span className="agent-desc">{agent.description}</span>
            </button>
            <button
              type="button"
              className="rule-remove"
              title="删除角色"
              onClick={() => void remove(agent.name)}
            >
              ×
            </button>
          </div>
        ))}
        {agents.length === 0 && (
          <p className="settings-desc">还没有角色；下方新建一个。</p>
        )}
      </div>

      <div className="panel-section-title">新建角色</div>
      <div className="rule-add">
        <input
          className="input"
          placeholder="角色名，如 reviewer"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-ghost"
          disabled={newName.trim().length === 0}
          onClick={createNew}
        >
          新建
        </button>
      </div>

      {selected !== null && (
        <>
          <div className="panel-section-title">编辑：{selected}</div>
          <textarea
            className="input agent-editor"
            rows={12}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            spellCheck={false}
          />
          <div className="panel-savebar">
            {note !== null && <span className="settings-note">{note}</span>}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void save()}
            >
              保存角色
            </button>
          </div>
        </>
      )}
    </div>
  );
}
