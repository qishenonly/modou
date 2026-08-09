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
  GuiSettingsPatch,
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

/** 可编辑表单字段（draft；保存时整体传给 saveSettings）。 */
type Draft = GuiSettingsPatch;

/** 逗号分隔文本 → 域名数组（编辑 Web 白名单/黑名单用）。 */
function splitList(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 钩子扁平列表 → Record<point, entries>（settings.hooks 形状）。 */
function hooksToRecord(
  list: readonly {
    readonly point: string;
    readonly command: string;
    readonly matcherTools?: readonly string[];
  }[],
): Record<
  string,
  readonly {
    readonly command: string;
    readonly matcherTools?: readonly string[];
  }[]
> {
  const record: Record<
    string,
    readonly { command: string; matcherTools?: readonly string[] }[]
  > = {};
  for (const hook of list) {
    record[hook.point] = [
      ...(record[hook.point] ?? []),
      {
        command: hook.command,
        ...(hook.matcherTools !== undefined
          ? { matcherTools: hook.matcherTools }
          : {}),
      },
    ];
  }
  return record;
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
  // 扩展编辑的临时输入
  const [ruleEffect, setRuleEffect] = useState<'allow' | 'deny'>('allow');
  const [ruleMatch, setRuleMatch] = useState('');
  const [mcpName, setMcpName] = useState('');
  const [mcpCmd, setMcpCmd] = useState('');
  const [hookPoint, setHookPoint] = useState('PreToolUse');
  const [hookCmd, setHookCmd] = useState('');

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
  // 扩展编辑的派生值（draft 优先，否则 settings 初值）
  const rulesList = draft.rules ?? settings?.rules ?? [];
  const mcpList = draft.mcpServers ?? settings?.mcpServers ?? [];
  const hookList =
    draft.hooks !== undefined
      ? Object.entries(draft.hooks).flatMap(([point, entries]) =>
          entries.map((entry) => ({
            point,
            command: entry.command,
            matcherTools: entry.matcherTools,
          })),
        )
      : (settings?.hooks ?? []);
  const allowedText = (
    draft.web?.allowedDomains ??
    settings?.web?.allowedDomains ??
    []
  ).join(', ');
  const deniedText = (
    draft.web?.deniedDomains ??
    settings?.web?.deniedDomains ??
    []
  ).join(', ');
  const snap = draft.snapshot ?? settings?.snapshot ?? null;

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
                      {rulesList.length === 0 ? (
                        <p className="settings-desc">
                          没有规则；添加一条 allow / deny 命令前缀规则。
                        </p>
                      ) : (
                        <div className="rule-list">
                          {rulesList.map((rule, index) => (
                            <div
                              key={`${rule.effect}-${rule.match}-${index}`}
                              className={`rule-item rule-${rule.effect}`}
                            >
                              <span className="rule-effect">
                                {rule.effect === 'allow' ? '允许' : '拒绝'}
                              </span>
                              <code className="rule-match">{rule.match}</code>
                              <button
                                type="button"
                                className="rule-remove"
                                title="删除规则"
                                onClick={() =>
                                  patch({
                                    rules: rulesList.filter(
                                      (_, i) => i !== index,
                                    ),
                                  })
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
                          value={ruleEffect}
                          onChange={(event) =>
                            setRuleEffect(
                              event.target.value as 'allow' | 'deny',
                            )
                          }
                        >
                          <option value="allow">允许</option>
                          <option value="deny">拒绝</option>
                        </select>
                        <input
                          className="input"
                          value={ruleMatch}
                          placeholder="命令前缀，如 rm -rf"
                          onChange={(event) => setRuleMatch(event.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={ruleMatch.trim().length === 0}
                          onClick={() => {
                            patch({
                              rules: [
                                ...rulesList,
                                { effect: ruleEffect, match: ruleMatch.trim() },
                              ],
                            });
                            setRuleMatch('');
                          }}
                        >
                          添加
                        </button>
                      </div>
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

                    {/* MCP 服务器（配置可编辑） */}
                    <div className="settings-field">
                      <label className="settings-label">MCP 服务器</label>
                      {mcpStatus.length > 0 && (
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
                      {mcpList.length === 0 ? (
                        <p className="settings-desc">
                          未配置服务器。下方添加（stdio 命令或 HTTP URL）。
                        </p>
                      ) : (
                        <div className="hook-list">
                          {mcpList.map((server) => (
                            <div key={server.name} className="hook-item">
                              <span className="hook-point">{server.name}</span>
                              <span className="hook-count">
                                {server.command !== undefined
                                  ? 'stdio'
                                  : 'http'}{' '}
                                · {server.enabled !== false ? '启用' : '停用'} ·{' '}
                                {server.command ?? server.url ?? ''}
                              </span>
                              <button
                                type="button"
                                className="rule-remove"
                                title="删除服务器"
                                onClick={() =>
                                  patch({
                                    mcpServers: mcpList.filter(
                                      (s) => s.name !== server.name,
                                    ),
                                  })
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
                          value={mcpName}
                          onChange={(event) => setMcpName(event.target.value)}
                        />
                        <input
                          className="input"
                          placeholder="命令 或 http://URL"
                          value={mcpCmd}
                          onChange={(event) => setMcpCmd(event.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={
                            mcpName.trim().length === 0 ||
                            mcpCmd.trim().length === 0
                          }
                          onClick={() => {
                            const target = mcpCmd.trim();
                            const isUrl = /^https?:\/\//.test(target);
                            patch({
                              mcpServers: [
                                ...mcpList,
                                {
                                  name: mcpName.trim(),
                                  ...(isUrl
                                    ? { url: target }
                                    : { command: target }),
                                  enabled: true,
                                  risk: 'network',
                                },
                              ],
                            });
                            setMcpName('');
                            setMcpCmd('');
                          }}
                        >
                          添加
                        </button>
                      </div>
                      <p className="settings-desc">
                        保存后重建会话并连接服务器。
                      </p>
                    </div>

                    {/* Hooks（配置可编辑） */}
                    <div className="settings-field">
                      <label className="settings-label">Hooks</label>
                      {hookList.length === 0 ? (
                        <p className="settings-desc">
                          未配置钩子。添加一条（钩子点 + 命令）。
                        </p>
                      ) : (
                        <div className="hook-list">
                          {hookList.map((hook, index) => (
                            <div
                              key={`${hook.point}-${index}`}
                              className="hook-item"
                            >
                              <span className="hook-point">{hook.point}</span>
                              <span className="hook-count">{hook.command}</span>
                              <button
                                type="button"
                                className="rule-remove"
                                title="删除钩子"
                                onClick={() =>
                                  patch({
                                    hooks: hooksToRecord(
                                      hookList.filter((_, i) => i !== index),
                                    ),
                                  })
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
                          value={hookPoint}
                          onChange={(event) => setHookPoint(event.target.value)}
                        >
                          <option value="SessionStart">SessionStart</option>
                          <option value="UserPromptSubmit">
                            UserPromptSubmit
                          </option>
                          <option value="PreToolUse">PreToolUse</option>
                          <option value="PostToolUse">PostToolUse</option>
                        </select>
                        <input
                          className="input"
                          placeholder="命令，如 ./scripts/check.sh"
                          value={hookCmd}
                          onChange={(event) => setHookCmd(event.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={hookCmd.trim().length === 0}
                          onClick={() => {
                            patch({
                              hooks: hooksToRecord([
                                ...hookList,
                                { point: hookPoint, command: hookCmd.trim() },
                              ]),
                            });
                            setHookCmd('');
                          }}
                        >
                          添加
                        </button>
                      </div>
                      <p className="settings-desc">保存后重建会话。</p>
                    </div>

                    {/* Skills（发现内容，只读） */}
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

                    {/* 自定义 agents（发现内容，只读） */}
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

                    {/* 联网工具（域名可编辑） */}
                    <div className="settings-field">
                      <label className="settings-label">联网域名白名单</label>
                      <input
                        className="input"
                        value={allowedText}
                        placeholder="逗号分隔，如 example.com（留空 = 不限制）"
                        onChange={(event) =>
                          patch({
                            web: {
                              allowedDomains: splitList(event.target.value),
                              deniedDomains: splitList(deniedText),
                            },
                          })
                        }
                      />
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">联网域名黑名单</label>
                      <input
                        className="input"
                        value={deniedText}
                        placeholder="逗号分隔，如 ads.example.com"
                        onChange={(event) =>
                          patch({
                            web: {
                              allowedDomains: splitList(allowedText),
                              deniedDomains: splitList(event.target.value),
                            },
                          })
                        }
                      />
                    </div>

                    {/* 快照（配置可编辑） */}
                    <div className="settings-field">
                      <label className="settings-label">快照</label>
                      <label className="settings-check">
                        <input
                          type="checkbox"
                          checked={snap?.enabled ?? true}
                          onChange={(event) =>
                            patch({
                              snapshot: {
                                ...(snap ?? {}),
                                enabled: event.target.checked,
                              },
                            })
                          }
                        />
                        启用自动快照（可 /rewind 回滚）
                      </label>
                      <div className="rule-add">
                        <input
                          className="input input-num"
                          type="number"
                          min={0}
                          placeholder="保留天数"
                          value={snap?.maxAgeDays ?? ''}
                          onChange={(event) =>
                            patch({
                              snapshot: {
                                ...(snap ?? {}),
                                maxAgeDays: Number(event.target.value),
                              },
                            })
                          }
                        />
                        <input
                          className="input input-num"
                          type="number"
                          min={1}
                          placeholder="每会话条数"
                          value={snap?.keepPerSession ?? ''}
                          onChange={(event) =>
                            patch({
                              snapshot: {
                                ...(snap ?? {}),
                                keepPerSession: Number(event.target.value),
                              },
                            })
                          }
                        />
                      </div>
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
