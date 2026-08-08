/**
 * 模型选择器（模态）：列出 /model 候选（listModels），点击即切换
 * （发送 /model <id>，上下文延续）。当前模型高亮。
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
          {models.map((model) => (
            <button
              key={model}
              type="button"
              className={`picker-item${model === currentModel ? ' picker-current' : ''}`}
              onClick={() => select(model)}
            >
              {model}
              {model === currentModel && (
                <span className="picker-tag">当前</span>
              )}
            </button>
          ))}
        </div>
        <div className="modal-hint">切换后上下文延续（历史消息不丢）</div>
      </div>
    </div>
  );
}
