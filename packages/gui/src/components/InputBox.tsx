/**
 * 底部输入框：自动增高多行 textarea，Enter 发送 / Shift+Enter 换行；
 * 运行中禁用提交并显示「停止」按钮；输入以 `/` 开头时提示内置斜杠命令。
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { BUILTIN_SLASH_COMMANDS } from '../../electron/slash';

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
    if (event.key === 'Escape' && running) {
      onStop();
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
      <div className="input-row">
        <textarea
          ref={ref}
          className="input-box"
          value={value}
          rows={1}
          placeholder={
            running ? '运行中…' : '输入任务，Enter 发送（Shift+Enter 换行）'
          }
          disabled={running}
          onChange={(event) => {
            setValue(event.target.value);
            autoGrow();
          }}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <button type="button" className="btn btn-stop" onClick={onStop}>
            ■ 停止
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-send"
            disabled={value.trim().length === 0}
            onClick={submit}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
