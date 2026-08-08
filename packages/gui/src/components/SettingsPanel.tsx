/**
 * 设置面板（Claude Desktop 式模态）：展示配置摘要（模型 / 供应商 / 权限 /
 * 目录边界），支持切换模型与切换项目。运行时不可变项只展示不编辑
 * （改配置请编辑 settings.json 后重启）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { GuiConfigSummary } from '../../electron/ipc';
import { PERMISSION_MODE_LABEL } from '../../electron/status';

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

export function SettingsPanel({
  onClose,
  onSelectDirectory,
}: {
  readonly onClose: () => void;
  readonly onSelectDirectory: () => void;
}): ReactNode {
  const [config, setConfig] = useState<GuiConfigSummary | null>(null);
  const [models, setModels] = useState<readonly string[]>([]);

  useEffect(() => {
    void window.modou.getConfig().then((value) => setConfig(value ?? null));
    void window.modou.listModels().then((value) => setModels(value));
  }, []);

  const switchModel = (modelId: string): void => {
    window.modou.sendCommand({ type: 'slash', name: 'model', args: modelId });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">设置</div>
        {config === null ? (
          <div className="modal-hint">尚未选择项目目录，请先在左侧选择。</div>
        ) : (
          <div className="settings-body">
            <div className="settings-section">项目</div>
            <Row label="项目目录" value={config.cwd} />
            <Row label="主目录" value={config.homeDir} />
            <button
              type="button"
              className="btn btn-ghost settings-switch"
              onClick={onSelectDirectory}
            >
              切换项目目录…
            </button>

            <div className="settings-section">模型</div>
            <div className="settings-row">
              <div className="settings-label">模型</div>
              <div className="settings-value">
                <select
                  className="select"
                  value={config.modelName}
                  onChange={(event) => switchModel(event.target.value)}
                >
                  {models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Row label="供应商" value={config.providerType} />

            <div className="settings-section">权限与上下文</div>
            <Row
              label="权限模式"
              value={PERMISSION_MODE_LABEL[config.permissionMode]}
            />
            <Row label="沙箱范围" value={config.sandbox} />
            <Row label="审批策略" value={config.policy} />
            <Row label="轮次上限" value={String(config.maxTurns)} />
            <Row label="压缩保留" value={`近 ${config.keepTurns} 轮原文`} />

            <div className="settings-section">关于</div>
            <Row label="版本" value={config.version} />
            <p className="settings-note">
              权限模式 / 沙箱范围 / 审批策略等运行时不可改，编辑{' '}
              <code>~/.modou/settings.json</code> 或项目{' '}
              <code>.modou/settings.json</code> 后重启生效。
            </p>
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
