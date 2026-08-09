/**
 * 设置面板（Claude Desktop 式：左侧分类导航 + 右侧表单；Codex 式：每项带
 * 描述与控件）。分类：模型 / 权限安全 / 上下文 / 扩展 / 外观 / 关于。
 *
 * 可编辑项（模型、供应商、Base URL、沙箱、审批策略、轮次、压缩保留）经
 * 保存写入项目 `.modou/settings.json`；主题即时生效并持久化。运行时不可改项
 * （规则表、扩展配置等）只展示，提示到 settings.json 编辑。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { McpServerStatus } from '@modou/core';
import type {
  GuiConfigSummary,
  GuiSettings,
  GuiTheme,
} from '../../electron/ipc';
import { PERMISSION_MODE_LABEL } from '../../electron/status';
import { applyTheme } from '../lib/theme';
import { formatTokens } from '../lib/format';

type Section =
  | 'model'
  | 'permissions'
  | 'context'
  | 'extensions'
  | 'appearance'
  | 'shortcuts'
  | 'about';

const SECTIONS: readonly { readonly id: Section; readonly label: string }[] = [
  { id: 'model', label: '模型' },
  { id: 'permissions', label: '权限安全' },
  { id: 'context', label: '上下文' },
  { id: 'extensions', label: '扩展' },
  { id: 'appearance', label: '外观' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'about', label: '关于' },
];

/** 快捷键清单（对齐实际绑定）。 */
const SHORTCUTS: readonly { readonly keys: string; readonly desc: string }[] = [
  { keys: '⌘K', desc: '聚焦输入框' },
  { keys: '⌘N', desc: '新建对话' },
  { keys: '⌘,', desc: '打开设置' },
  { keys: 'Esc', desc: '停止生成 / 关闭弹窗' },
  { keys: 'Enter', desc: '发送消息' },
  { keys: 'Shift+Enter', desc: '换行' },
  { keys: '↑ / ↓', desc: '召回上一条输入' },
];

const PROVIDERS: readonly { readonly value: string; readonly label: string }[] =
  [
    { value: 'openai-compat', label: 'OpenAI 兼容（含国产模型 / Ollama）' },
    { value: 'anthropic', label: 'Anthropic' },
  ];

/** 沙箱范围（Codex 式正交维度 1）。 */
const SANDBOXES: readonly {
  readonly value: string;
  readonly label: string;
  readonly desc: string;
}[] = [
  { value: 'read-only', label: '只读', desc: '只能读取文件，不能修改或执行' },
  {
    value: 'workspace-write',
    label: '工作区写',
    desc: '可在项目目录内修改文件与执行命令',
  },
  {
    value: 'full-access',
    label: '完全访问',
    desc: '可访问整个文件系统（需显式开启）',
  },
];

/** 审批策略（Codex 式正交维度 2）。 */
const POLICIES: readonly {
  readonly value: string;
  readonly label: string;
  readonly desc: string;
}[] = [
  {
    value: 'untrusted',
    label: '逐操作审批',
    desc: '大多数写 / 执行操作都弹确认',
  },
  { value: 'on-request', label: '按需审批', desc: '模型自认风险时才询问' },
  {
    value: 'never',
    label: '不拦截',
    desc: '工作区内放手干（危险命令仍强制确认）',
  },
];

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
      <div className="settings-value" title={value}>
        {value}
      </div>
    </div>
  );
}

/** 可编辑表单字段（draft）。 */
interface Draft {
  readonly provider?: string;
  readonly model?: string;
  readonly baseURL?: string;
  readonly sandbox?: string;
  readonly policy?: string;
  readonly maxTurns?: number;
  readonly keepTurns?: number;
}

export function SettingsPanel({
  onClose,
  onSelectDirectory,
  onSaved,
}: {
  readonly onClose: () => void;
  readonly onSelectDirectory: () => void;
  readonly onSaved?: (needRestart: boolean) => void;
}): ReactNode {
  const [section, setSection] = useState<Section>('model');
  const [config, setConfig] = useState<GuiConfigSummary | null>(null);
  const [settings, setSettings] = useState<GuiSettings | null>(null);
  const [models, setModels] = useState<readonly string[]>([]);
  const [skills, setSkills] = useState<
    readonly { readonly name: string; readonly description: string }[]
  >([]);
  const [mcpStatus, setMcpStatus] = useState<readonly McpServerStatus[]>([]);
  const [theme, setTheme] = useState<GuiTheme>('system');
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  useEffect(() => {
    void window.modou.getConfig().then((value) => setConfig(value ?? null));
    void window.modou.getSettings().then((value) => setSettings(value ?? null));
    void window.modou.listModels().then((value) => setModels(value));
    void window.modou.listSkills().then((value) => setSkills(value));
    void window.modou.getMcpStatus().then((value) => setMcpStatus(value));
    void window.modou.getTheme().then((value) => {
      setTheme(value);
      applyTheme(value);
    });
  }, []);

  const patch = (partial: Partial<Draft>): void => {
    setDraft((prev) => ({ ...prev, ...partial }));
    setSaveNote(null);
  };

  const dirty = Object.keys(draft).length > 0;

  const save = async (): Promise<void> => {
    setSaving(true);
    const result = await window.modou.saveSettings(draft);
    if (result.ok) {
      setSaveNote(
        result.needRestart
          ? '已保存并应用（权限 / 上下文 / 供应商类改动已重建会话）。'
          : '已保存。',
      );
      onSaved?.(result.needRestart);
    } else {
      setSaveNote(result.message ?? '保存失败');
    }
    setDraft({});
    setSaving(false);
  };

  const changeTheme = (value: GuiTheme): void => {
    setTheme(value);
    applyTheme(value);
    void window.modou.setTheme(value);
  };

  const baseURL = draft.baseURL ?? settings?.baseURL ?? '';
  const model = draft.model ?? settings?.model ?? '';
  const sandbox = draft.sandbox ?? settings?.sandbox ?? '';
  const policy = draft.policy ?? settings?.policy ?? '';
  const maxTurns = draft.maxTurns ?? settings?.maxTurns ?? 10;
  const keepTurns = draft.keepTurns ?? settings?.keepTurns ?? 6;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">设置</div>
        <div className="settings-layout">
          <nav className="settings-nav">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings-nav-item${section === item.id ? ' settings-nav-active' : ''}`}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {config === null || settings === null ? (
              <div className="modal-hint">
                尚未选择项目目录，请先在左侧选择。
              </div>
            ) : (
              <>
                {/* 模型 */}
                {section === 'model' && (
                  <>
                    <h3 className="settings-section-title">模型</h3>
                    <div className="settings-field">
                      <label className="settings-label">供应商</label>
                      <select
                        className="select"
                        value={settings.provider}
                        onChange={(event) =>
                          patch({ provider: event.target.value })
                        }
                      >
                        {PROVIDERS.map((provider) => (
                          <option key={provider.value} value={provider.value}>
                            {provider.label}
                          </option>
                        ))}
                      </select>
                      <p className="settings-desc">
                        供应商决定 API 端点与密钥来源；保存后重启生效。
                      </p>
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">模型</label>
                      <select
                        className="select"
                        value={model}
                        onChange={(event) =>
                          patch({ model: event.target.value })
                        }
                      >
                        {models.map((candidate) => (
                          <option key={candidate} value={candidate}>
                            {candidate}
                          </option>
                        ))}
                      </select>
                      <p className="settings-desc">
                        切换后上下文延续；也可直接发送 /model &lt;ID&gt;。
                      </p>
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">Base URL</label>
                      <input
                        className="input"
                        value={baseURL}
                        placeholder="OpenAI 兼容端点（可留空）"
                        onChange={(event) =>
                          patch({ baseURL: event.target.value })
                        }
                      />
                    </div>
                    {config.contextWindow !== undefined && (
                      <div className="settings-field">
                        <label className="settings-label">上下文窗口</label>
                        <p className="settings-desc">
                          {formatTokens(config.contextWindow)}{' '}
                          tokens（当前模型能力；压缩阈值默认取 70%）
                        </p>
                      </div>
                    )}
                  </>
                )}

                {/* 权限安全 */}
                {section === 'permissions' && (
                  <>
                    <h3 className="settings-section-title">权限安全</h3>
                    <p className="settings-desc">
                      两个正交维度：沙箱范围（能碰哪些文件）×
                      审批策略（什么操作要问）。
                    </p>
                    <div className="settings-field">
                      <label className="settings-label">沙箱范围</label>
                      <select
                        className="select"
                        value={sandbox}
                        onChange={(event) =>
                          patch({ sandbox: event.target.value })
                        }
                      >
                        {SANDBOXES.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label} — {option.desc}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">审批策略</label>
                      <select
                        className="select"
                        value={policy}
                        onChange={(event) =>
                          patch({ policy: event.target.value })
                        }
                      >
                        {POLICIES.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label} — {option.desc}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">规则表</label>
                      {settings.rules.length === 0 ? (
                        <p className="settings-desc">
                          未配置 allow / deny 规则（在 settings.json 的
                          permission.rules 添加）。
                        </p>
                      ) : (
                        <div className="rule-list">
                          {settings.rules.map((rule, index) => (
                            <div
                              key={index}
                              className={`rule-item rule-${rule.effect}`}
                            >
                              <span className="rule-effect">
                                {rule.effect === 'allow' ? '允许' : '拒绝'}
                              </span>
                              <code className="rule-match">{rule.match}</code>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">正交矩阵</label>
                      <table className="perm-matrix">
                        <thead>
                          <tr>
                            <th />
                            <th>untrusted</th>
                            <th>on-request</th>
                            <th>never</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td className="perm-dim">只读</td>
                            <td>读也问</td>
                            <td>基本不问</td>
                            <td>静默只读</td>
                          </tr>
                          <tr>
                            <td className="perm-dim">工作区写</td>
                            <td>每次写/执行都问</td>
                            <td>自认风险才问</td>
                            <td>工作区内放手干</td>
                          </tr>
                          <tr>
                            <td className="perm-dim">完全访问</td>
                            <td>每次都问</td>
                            <td>危险操作才问</td>
                            <td>完全放手</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="settings-desc">
                      当前生效：{PERMISSION_MODE_LABEL[config.permissionMode]}
                      。权限改动保存后需重启。
                    </p>
                  </>
                )}

                {/* 上下文 */}
                {section === 'context' && (
                  <>
                    <h3 className="settings-section-title">上下文</h3>
                    <div className="settings-field">
                      <label className="settings-label">轮次上限</label>
                      <input
                        className="input input-num"
                        type="number"
                        min={1}
                        value={maxTurns}
                        onChange={(event) =>
                          patch({ maxTurns: Number(event.target.value) })
                        }
                      />
                      <p className="settings-desc">
                        单个任务允许的最大模型请求轮数（防失控）。
                      </p>
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">压缩保留</label>
                      <input
                        className="input input-num"
                        type="number"
                        min={1}
                        value={keepTurns}
                        onChange={(event) =>
                          patch({ keepTurns: Number(event.target.value) })
                        }
                      />
                      <p className="settings-desc">
                        上下文压缩时保留的最近 N 轮原文（更早的折叠进摘要）。
                      </p>
                    </div>
                  </>
                )}

                {/* 扩展 */}
                {section === 'extensions' && (
                  <>
                    <h3 className="settings-section-title">扩展</h3>
                    <div className="settings-field">
                      <label className="settings-label">MCP 服务器</label>
                      {mcpStatus.length === 0 ? (
                        <p className="settings-desc">
                          未配置（settings.json 的 mcp.servers 键）。
                        </p>
                      ) : (
                        <div className="mcp-list">
                          {mcpStatus.map((server) => (
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
                                {server.toolCount} 工具
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">Hooks</label>
                      {settings.hooks.length === 0 ? (
                        <p className="settings-desc">
                          未配置钩子（settings.json 的 hooks 键）。
                        </p>
                      ) : (
                        <div className="hook-list">
                          {settings.hooks.map((hook) => (
                            <div key={hook.point} className="hook-item">
                              <span className="hook-point">{hook.point}</span>
                              <span className="hook-count">
                                {hook.count} 条
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">Skills</label>
                      {skills.length === 0 ? (
                        <p className="settings-desc">
                          未发现技能（.modou/skills/&lt;name&gt;/SKILL.md）。
                        </p>
                      ) : (
                        <div className="skill-list">
                          {skills.map((skill) => (
                            <div key={skill.name} className="skill-item">
                              <span className="skill-name">{skill.name}</span>
                              <span className="skill-desc">
                                {skill.description}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">自定义 agents</label>
                      {settings.agents.length === 0 ? (
                        <p className="settings-desc">
                          未发现角色（.modou/agents/&lt;name&gt;.md）。
                        </p>
                      ) : (
                        <div className="skill-list">
                          {settings.agents.map((agent) => (
                            <div key={agent.name} className="skill-item">
                              <span className="skill-name">{agent.name}</span>
                              <span className="skill-desc">
                                {agent.description}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">联网工具</label>
                      <p className="settings-desc">
                        {settings.web === null
                          ? '未限制域名（settings.json 的 web 键可配白名单 / 黑名单）。'
                          : `白名单 ${settings.web.allowedDomains} 个 / 黑名单 ${settings.web.deniedDomains} 个域名。`}
                      </p>
                    </div>
                  </>
                )}

                {/* 外观 */}
                {section === 'appearance' && (
                  <>
                    <h3 className="settings-section-title">外观</h3>
                    <div className="settings-field">
                      <label className="settings-label">主题</label>
                      <select
                        className="select"
                        value={theme}
                        onChange={(event) =>
                          changeTheme(event.target.value as GuiTheme)
                        }
                      >
                        <option value="light">浅色</option>
                        <option value="dark">深色</option>
                        <option value="system">跟随系统</option>
                      </select>
                      <p className="settings-desc">
                        即时生效并记住（下次启动沿用）。
                      </p>
                    </div>
                  </>
                )}

                {/* 关于 */}
                {section === 'about' && (
                  <>
                    <h3 className="settings-section-title">关于</h3>
                    <Row label="版本" value={config.version} />
                    <Row label="项目目录" value={config.cwd} />
                    <Row label="主目录" value={config.homeDir} />
                    <Row
                      label="会话位置"
                      value={`${config.homeDir}/.modou/sessions`}
                    />
                    <div className="settings-field">
                      <button
                        type="button"
                        className="btn btn-ghost settings-switch"
                        onClick={() => window.modou.openPath(config.cwd)}
                      >
                        在文件管理器中打开项目
                      </button>
                    </div>
                    <div className="settings-field">
                      <button
                        type="button"
                        className="btn btn-ghost settings-switch"
                        onClick={onSelectDirectory}
                      >
                        切换项目目录…
                      </button>
                    </div>
                  </>
                )}

                {/* 快捷键 */}
                {section === 'shortcuts' && (
                  <>
                    <h3 className="settings-section-title">快捷键</h3>
                    <div className="shortcut-list">
                      {SHORTCUTS.map((shortcut) => (
                        <div key={shortcut.keys} className="shortcut-row">
                          <kbd className="shortcut-keys">{shortcut.keys}</kbd>
                          <span className="shortcut-desc">{shortcut.desc}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {config !== null && (
          <div className="settings-footer">
            {saveNote !== null && (
              <span className="settings-note">{saveNote}</span>
            )}
            <div className="settings-footer-actions">
              {dirty && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void save()}
                  disabled={saving}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              )}
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                关闭
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
