/**
 * 设置面板（Claude Desktop 式：左侧分类导航 + 右侧表单；Codex 式：每项带
 * 描述与控件）。分类：模型 / 权限安全 / 上下文 / 外观 / 快捷键 / 关于。
 *
 * 可编辑项（模型、供应商、Base URL、沙箱、审批策略、轮次、压缩保留、规则表）
 * 保存即生效（权限/上下文类自动重建会话）。扩展功能（MCP/Hooks/Skills/Agents）
 * 在左侧栏「扩展」区各自独立页面管理。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { ContextStateData } from '@modou/core';
import type {
  GuiConfigSummary,
  GuiSettings,
  GuiSettingsPatch,
  GuiTheme,
} from '../../electron/ipc';
import { PERMISSION_MODE_LABEL } from '../../electron/status';
import { applyTheme } from '../lib/theme';
import { formatTokens } from '../lib/format';
import {
  AgentsContent,
  HooksContent,
  McpContent,
  SkillsContent,
} from './ExtensionPanels';
import { ModelManagerContent } from './ModelManagerPanel';
import { Select } from './Select';

type Section =
  | 'model'
  | 'permissions'
  | 'context'
  | 'mcp'
  | 'hooks'
  | 'skills'
  | 'agents'
  | 'appearance'
  | 'shortcuts'
  | 'about';

const SECTIONS: readonly { readonly id: Section; readonly label: string }[] = [
  { id: 'model', label: '模型' },
  { id: 'permissions', label: '权限安全' },
  { id: 'context', label: '上下文' },
  { id: 'mcp', label: 'MCP' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Agents' },
  { id: 'appearance', label: '外观' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'about', label: '关于' },
];

/** 快捷键清单（对齐实际绑定）。 */
const SHORTCUTS: readonly { readonly keys: string; readonly desc: string }[] = [
  { keys: '⌘K', desc: '聚焦输入框' },
  { keys: '⌘N', desc: '新建对话' },
  { keys: '⌘,', desc: '打开设置' },
  { keys: '⌘⇧O', desc: '打开模型管理' },
  { keys: '⌘⇧T', desc: '打开定时任务' },
  { keys: '⌘U', desc: '查看用量' },
  { keys: '⌘\\', desc: '折叠 / 展开侧栏' },
  { keys: 'Esc', desc: '停止生成 / 关闭弹窗 / 拒绝审批' },
  { keys: 'Enter', desc: '发送消息' },
  { keys: 'Shift+Enter', desc: '换行' },
  { keys: '↑ / ↓', desc: '召回上一条输入' },
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

/** 逗号分隔文本 → 域名数组（联网白名单/黑名单编辑）。 */
function splitList(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
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
  const [theme, setTheme] = useState<GuiTheme>('system');
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  // 当前上下文用量（上下文分类实时核算）
  const [context, setContext] = useState<ContextStateData | null>(null);
  // 规则编辑的临时输入
  const [ruleEffect, setRuleEffect] = useState<'allow' | 'deny'>('allow');
  const [ruleMatch, setRuleMatch] = useState('');

  useEffect(() => {
    void window.modou.getConfig().then((value) => setConfig(value ?? null));
    void window.modou.getSettings().then((value) => setSettings(value ?? null));
    void window.modou.getContext().then((value) => setContext(value));
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

  const sandbox = draft.sandbox ?? settings?.sandbox ?? '';
  const policy = draft.policy ?? settings?.policy ?? '';
  const maxTurns = draft.maxTurns ?? settings?.maxTurns ?? 10;
  const keepTurns = draft.keepTurns ?? settings?.keepTurns ?? 6;
  // 规则编辑（draft 优先，否则 settings 初值）
  const rulesList = draft.rules ?? settings?.rules ?? [];
  // 联网域名编辑（draft 优先，否则 settings 初值）
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
                    <ModelManagerContent />
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
                      <Select
                        value={sandbox}
                        options={SANDBOXES}
                        onChange={(v) => patch({ sandbox: v })}
                      />
                    </div>
                    <div className="settings-field">
                      <label className="settings-label">审批策略</label>
                      <Select
                        value={policy}
                        options={POLICIES}
                        onChange={(v) => patch({ policy: v })}
                      />
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
                        <Select
                          value={ruleEffect}
                          options={[
                            { value: 'allow', label: '允许' },
                            { value: 'deny', label: '拒绝' },
                          ]}
                          onChange={(v) => setRuleEffect(v as 'allow' | 'deny')}
                        />
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
                      <p className="settings-desc">
                        WebFetch / WebSearch 允许访问的域名；留空不限制。
                      </p>
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
                    <div className="panel-section-title">当前上下文用量</div>
                    {context === null ? (
                      <p className="settings-desc">加载中…</p>
                    ) : (
                      <div className="context-body">
                        {context.sections.map((section) => {
                          const ratio =
                            context.total > 0
                              ? section.tokens / context.total
                              : 0;
                          return (
                            <div key={section.name} className="context-row">
                              <div className="context-head">
                                <span className="context-name">
                                  {section.name}
                                </span>
                                <span className="context-tokens">
                                  {formatTokens(section.tokens)}（
                                  {Math.round(ratio * 100)}%）
                                </span>
                              </div>
                              <div className="context-bar">
                                <div
                                  className="context-fill"
                                  style={{
                                    width: `${Math.min(100, ratio * 100)}%`,
                                  }}
                                />
                              </div>
                            </div>
                          );
                        })}
                        <div className="context-total">
                          合计：{formatTokens(context.total)} tokens
                          {context.nearCompaction === true && (
                            <span className="context-warn">
                              {' '}
                              · 接近压缩阈值
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    <p className="settings-desc">
                      上下文是会话日志的投影：稳定前缀（系统 + 工具 + 指令）→
                      摘要状态 → 近 N 轮原文。超过约 70%
                      上下文窗口会自动增量压缩（折叠早期轮次进摘要，
                      原文仍在日志里，可 /context 查看分项）。
                    </p>
                    <div className="panel-section-title">配置</div>
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

                {section === 'mcp' && (
                  <>
                    <h3 className="settings-section-title">MCP</h3>
                    <McpContent />
                  </>
                )}

                {section === 'hooks' && (
                  <>
                    <h3 className="settings-section-title">Hooks</h3>
                    <HooksContent />
                  </>
                )}

                {section === 'skills' && (
                  <>
                    <h3 className="settings-section-title">Skills</h3>
                    <SkillsContent />
                  </>
                )}

                {section === 'agents' && (
                  <>
                    <h3 className="settings-section-title">Agents</h3>
                    <AgentsContent />
                  </>
                )}

                {/* 外观 */}
                {section === 'appearance' && (
                  <>
                    <h3 className="settings-section-title">外观</h3>
                    <div className="settings-field">
                      <label className="settings-label">主题</label>
                      <Select
                        value={theme}
                        options={[
                          { value: 'light', label: '浅色' },
                          { value: 'dark', label: '深色' },
                          { value: 'system', label: '跟随系统' },
                        ]}
                        onChange={(value) => changeTheme(value as GuiTheme)}
                      />
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
                    <div className="about-intro">
                      <p className="settings-desc">
                        <b>modou（墨斗）</b>——本地优先的终端编码
                        Agent。在所选项目目录内
                        读写文件、执行命令、自主完成任务：读代码、改代码、跑测试、提交
                        commit、写文档。
                      </p>
                      <ul className="about-features">
                        <li>会话可恢复 / 快照回滚 / 成本核算</li>
                        <li>权限正交模型（沙箱范围 × 审批策略）+ 规则表</li>
                        <li>
                          计划模式 / 待办清单 / 子代理 / 长期记忆 / 联网工具
                        </li>
                        <li>
                          扩展走开放标准：MCP / AGENTS.md / SKILL.md / 自定义
                          agents / Hooks
                        </li>
                      </ul>
                      <p className="settings-desc">
                        GUI 基于 Electron + React；core 与 TUI
                        共用同一套事件流协议（Event↑ / Command↓），界面可替换。
                      </p>
                    </div>
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
