/**
 * 底部输入框（Claude Desktop 式）：
 * - 圆角大输入区，无默认边框（hover/聚焦加深）；自动增高；
 * - 右侧圆形发送按钮：有内容时橙色，否则灰色禁用；
 * - 运行中：发送按钮变为「停止」方块，输入禁用；
 * - 输入以 / 开头时提示内置斜杠命令。
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { BUILTIN_SLASH_COMMANDS } from '../../electron/slash';

/** 发送箭头（↑）与停止方块（■）图标。 */
function SendIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" className="icon-send" aria-hidden="true">
      <path
        d="M8.75 3.22a.75.75 0 0 0-1.5 0v6.75a.75.75 0 0 0 1.5 0V3.22Z"
        fill="currentColor"
      />
      <path
        d="M3.22 8.75c0-.41.34-.75.75-.75h8.06a.75.75 0 0 1 0 1.5H3.97a.75.75 0 0 1-.75-.75Z"
        fill="currentColor"
      />
    </svg>
  );
}

function StopIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" className="icon-stop" aria-hidden="true">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" />
    </svg>
  );
}

export function InputBox({
  running,
  onSubmit,
  onStop,
}: {
  readonly running: boolean;
  readonly onSubmit: (text: string) => void;
  readonly onStop: () => void;
}): ReactNode {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const showSlash = !running && value.trim().startsWith('/');
  const canSend = value.trim().length > 0;

  const submit = (): void => {
    const text = value.trim();
    if (text.length === 0) return;
    onSubmit(text);
    setValue('');
    if (ref.current !== null) ref.current.style.height = 'auto';
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (!running) submit();
      return;
    }
  };

  const autoGrow = (): void => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="input-area">
      {showSlash && (
        <div className="slash-hint">
          {BUILTIN_SLASH_COMMANDS.map((command) => (
            <span key={command.name} className="slash-chip">
              {command.usage}
            </span>
          ))}
        </div>
      )}
      <div className="input-box-shell">
        <textarea
          ref={ref}
          className="input-box"
          value={value}
          rows={1}
          placeholder={running ? '正在运行…' : '输入任务，Enter 发送'}
          disabled={running}
          onChange={(event) => {
            setValue(event.target.value);
            autoGrow();
          }}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <button
            type="button"
            className="btn-send btn-stop"
            onClick={onStop}
            title="停止"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className={`btn-send${canSend ? ' btn-send-ready' : ''}`}
            disabled={!canSend}
            onClick={submit}
            title="发送"
          >
            <SendIcon />
          </button>
        )}
      </div>
      <div className="input-foot">
        <span>Enter 发送 · Shift+Enter 换行</span>
        <span>/ 开头触发斜杠命令</span>
      </div>
    </div>
  );
}
