/**
 * 模型管理面板（参考 ccswitch）：多供应商 / 中转站 / 源头管理。
 *
 * - 左侧：供应商列表（Anthropic / OpenAI / 中转站 / Ollama…），可添加 / 删除；
 * - 右侧：选中供应商的详情——名称、类型、Base URL、API Key、模型列表；
 * - 模型：可从上游 `/models` 拉取（主进程 fetch，兼容所有 OpenAI 兼容中转站），
 *   也可手动添加 / 删除；选中某模型「设为当前」→ 写 active + 重建 bridge。
 * - 当前生效模型在顶部展示。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { ProviderEntry, ProviderState } from '../../electron/ipc';
import { Select } from './Select';

const TYPE_LABEL: Readonly<Record<string, string>> = {
  'openai-compat': 'OpenAI 兼容（含中转站 / Ollama / 国产模型）',
  anthropic: 'Anthropic',
};

export function ModelManagerContent(): ReactNode {
  const [state, setState] = useState<ProviderState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteMsg, setRemoteMsg] = useState<string | null>(null);
  const [newModel, setNewModel] = useState('');

  useEffect(() => {
    void window.modou.getProviders().then((value) => {
      setState(value);
      setSelectedId(value.providers[0]?.id ?? null);
    });
  }, []);

  const selected =
    state?.providers.find((provider) => provider.id === selectedId) ?? null;

  /** 变更后同步到本地 state 并立即写盘（供应商列表）。 */
  const commit = (next: ProviderState): void => {
    setState(next);
    void window.modou.saveProviders(next.providers);
  };

  const updateSelected = (patch: Partial<ProviderEntry>): void => {
    if (state === null || selectedId === null) return;
    commit({
      ...state,
      providers: state.providers.map((provider) =>
        provider.id === selectedId ? { ...provider, ...patch } : provider,
      ),
    });
  };

  const addProvider = (): void => {
    if (state === null) return;
    const entry: ProviderEntry = {
      id: crypto.randomUUID(),
      name: '新供应商',
      type: 'openai-compat',
      baseURL: '',
      apiKey: '',
      models: [],
    };
    commit({ ...state, providers: [...state.providers, entry] });
    setSelectedId(entry.id);
  };

  const removeProvider = (id: string): void => {
    if (state === null) return;
    const next = {
      ...state,
      providers: state.providers.filter((provider) => provider.id !== id),
    };
    commit(next);
    if (selectedId === id) {
      setSelectedId(next.providers[0]?.id ?? null);
    }
  };

  /** 从上游拉取模型（合并进该供应商列表并保存）。 */
  const pullRemote = async (): Promise<void> => {
    if (selected === null || state === null) return;
    setRemoteBusy(true);
    setRemoteMsg(null);
    const result = await window.modou.listRemoteModels({
      baseURL: selected.baseURL,
      apiKey: selected.apiKey,
    });
    if (result.ok) {
      const merged = [...new Set([...selected.models, ...result.models])];
      updateSelected({ models: merged });
      setRemoteMsg(
        `拉取到 ${result.models.length} 个模型（共 ${merged.length} 个）。`,
      );
    } else {
      setRemoteMsg(result.message ?? '拉取失败');
    }
    setRemoteBusy(false);
  };

  /** 把选中模型设为当前（写 active + 重建 bridge）。 */
  const setActive = (model: string): void => {
    if (selected === null) return;
    void window.modou.setActiveModel({ providerId: selected.id, model });
  };

  const activeName = state?.active
    ? `${state.active.model} @ ${
        state.providers.find((p) => p.id === state.active?.providerId)?.name ??
        state.active.providerId
      }`
    : '未配置模型';

  return (
    <div className="ext-content">
      {state === null ? (
        <div className="modal-hint">加载中…</div>
      ) : (
        <>
          <div className="model-active">
            当前模型：<b>{activeName}</b>
          </div>
          <div className="model-manage">
            {/* 左侧：供应商列表 */}
            <div className="model-providers">
              <div className="model-providers-label">供应商</div>
              {state.providers.length === 0 && (
                <p className="settings-desc">
                  还没有供应商；添加一个（官方 / 中转站 / Ollama）。
                </p>
              )}
              <div className="model-provider-list">
                {state.providers.map((provider) => (
                  <div
                    key={provider.id}
                    className={`model-provider${provider.id === selectedId ? ' model-provider-active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(provider.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        setSelectedId(provider.id);
                      }
                    }}
                  >
                    <span className="model-provider-name">{provider.name}</span>
                    <span className="model-provider-type">
                      {provider.type === 'anthropic'
                        ? 'Anthropic'
                        : 'OpenAI 兼容'}
                    </span>
                    {state.active?.providerId === provider.id && (
                      <span className="model-provider-active-tag">当前</span>
                    )}
                    <button
                      type="button"
                      className="rule-remove"
                      title="删除供应商"
                      onClick={(event) => {
                        event.stopPropagation();
                        removeProvider(provider.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-ghost model-add"
                onClick={addProvider}
              >
                + 添加供应商
              </button>
            </div>

            {/* 右侧：供应商详情 + 模型管理 */}
            <div className="model-detail">
              {selected === null ? (
                <p className="settings-desc">选择左侧供应商，或添加一个。</p>
              ) : (
                <>
                  <div className="settings-field">
                    <label className="settings-label">名称</label>
                    <input
                      className="input"
                      value={selected.name}
                      onChange={(event) =>
                        updateSelected({ name: event.target.value })
                      }
                    />
                  </div>
                  <div className="settings-field">
                    <label className="settings-label">类型</label>
                    <Select
                      value={selected.type}
                      options={[
                        {
                          value: 'openai-compat',
                          label: 'OpenAI 兼容（含中转站 / Ollama / 国产模型）',
                        },
                        { value: 'anthropic', label: 'Anthropic' },
                      ]}
                      onChange={(value) =>
                        updateSelected({ type: value as ProviderEntry['type'] })
                      }
                    />
                  </div>
                  <div className="settings-field">
                    <label className="settings-label">Base URL</label>
                    <input
                      className="input"
                      value={selected.baseURL}
                      placeholder="如 https://api.deepseek.com/v1"
                      onChange={(event) =>
                        updateSelected({ baseURL: event.target.value })
                      }
                    />
                    <p className="settings-desc">
                      OpenAI 兼容端点（含 /v1）；Anthropic 官方可留空。
                    </p>
                  </div>
                  <div className="settings-field">
                    <label className="settings-label">API Key</label>
                    <input
                      className="input"
                      type="password"
                      value={selected.apiKey}
                      placeholder="sk-…"
                      onChange={(event) =>
                        updateSelected({ apiKey: event.target.value })
                      }
                    />
                    <p className="settings-desc">
                      保存在 ~/.modou/providers.json（本地）。
                    </p>
                  </div>

                  <div className="panel-section-title">模型</div>
                  <div className="model-model-list">
                    {selected.models.length === 0 ? (
                      <p className="settings-desc">
                        还没有模型。点「从上游拉取」自动获取该供应商全部模型，或手动添加。
                      </p>
                    ) : (
                      selected.models.map((model) => {
                        const isActive =
                          state.active?.providerId === selected.id &&
                          state.active.model === model;
                        return (
                          <div
                            key={model}
                            className={`model-model-item${isActive ? ' model-model-active' : ''}`}
                          >
                            <span className="model-model-id">{model}</span>
                            {isActive && (
                              <span className="picker-tag">当前</span>
                            )}
                            <button
                              type="button"
                              className="btn btn-ghost model-set"
                              disabled={isActive}
                              onClick={() => setActive(model)}
                            >
                              设为当前
                            </button>
                            <button
                              type="button"
                              className="rule-remove"
                              title="删除模型"
                              onClick={() =>
                                updateSelected({
                                  models: selected.models.filter(
                                    (m) => m !== model,
                                  ),
                                })
                              }
                            >
                              ×
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <div className="rule-add">
                    <input
                      className="input"
                      placeholder="手动添加模型 ID"
                      value={newModel}
                      onChange={(event) => setNewModel(event.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={newModel.trim().length === 0}
                      onClick={() => {
                        updateSelected({
                          models: [...selected.models, newModel.trim()],
                        });
                        setNewModel('');
                      }}
                    >
                      添加
                    </button>
                  </div>
                  <div className="model-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={
                        remoteBusy || selected.baseURL.trim().length === 0
                      }
                      onClick={() => void pullRemote()}
                    >
                      {remoteBusy ? '拉取中…' : '从上游拉取模型'}
                    </button>
                    {remoteMsg !== null && (
                      <span className="settings-note">{remoteMsg}</span>
                    )}
                  </div>
                  <p className="settings-desc">
                    编辑会自动保存到
                    providers.json；「设为当前」会重建会话生效。
                    {TYPE_LABEL[selected.type]}
                  </p>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
