/**
 * /help 面板（模态）：列出全部内置斜杠命令与用法。
 * 与 TUI 的 renderHelpText 同数据源（BUILTIN_SLASH_COMMANDS）。
 */
import type { ReactNode } from 'react';
import { BUILTIN_SLASH_COMMANDS } from '../../electron/slash';

export function HelpPanel({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal help-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">斜杠命令</div>
        <div className="help-list">
          {BUILTIN_SLASH_COMMANDS.map((command) => (
            <div key={command.name} className="help-row">
              <code className="help-usage">{command.usage}</code>
              <span className="help-desc">{command.description}</span>
            </div>
          ))}
        </div>
        <div className="modal-hint">在输入框输入 / 开头即可触发；Esc 关闭</div>
      </div>
    </div>
  );
}
