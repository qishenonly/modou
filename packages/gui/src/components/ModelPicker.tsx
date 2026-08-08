/**
 * 模型选择器（Claude Desktop 式模态）：列出 /model 候选，当前模型带对勾。
 * 选中即发送 /model <id>（上下文延续），关闭弹窗。
 */
import { useEffect, useState, type ReactNode } from 'react';

export function ModelPicker({
  currentModel,
  onClose,
}: {
  readonly currentModel: string;
  readonly onClose: () => void;
}): ReactNode {
  const [models, setModels] = useState<readonly string[]>([]);

  useEffect(() => {
    void window.modou.listModels().then((value) => setModels(value));
  }, []);

  const select = (modelId: string): void => {
    window.modou.sendCommand({ type: 'slash', name: 'model', args: modelId });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal picker"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">切换模型</div>
        <div className="picker-list">
          {models.length === 0 && (
            <div className="modal-hint">没有可用模型</div>
          )}
          {models.map((model) => {
            const current = model === currentModel;
            return (
              <button
                key={model}
                type="button"
                className={`picker-item${current ? ' picker-current' : ''}`}
                onClick={() => select(model)}
              >
                <span className="picker-radio" aria-hidden="true">
                  {current && (
                    <svg
                      viewBox="0 0 16 16"
                      className="picker-check"
                      aria-hidden="true"
                    >
                      <path
                        d="M3.5 8.5 6.6 11.5l5.9-7"
                        stroke="currentColor"
                        strokeWidth="2"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <span className="picker-name">{model}</span>
              </button>
            );
          })}
        </div>
        <div className="modal-hint">切换后上下文延续（历史消息不丢）</div>
      </div>
    </div>
  );
}
