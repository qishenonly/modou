/**
 * 底部输入框（Claude Desktop 式）：
 * - 圆角大输入区，无默认边框（hover/聚焦加深）；自动增高；
 * - 右侧圆形发送按钮：有内容时橙色，否则灰色禁用；
 * - 运行中：发送按钮变为「停止」方块，输入禁用；
 * - 输入以 / 开头时提示内置斜杠命令；
 * - 粘贴 / 拖拽图片 → 转为 data URI 附件随消息提交（多模态）。
 */
import {
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
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

/** 从 FileList 里挑出图片文件，逐个转 data URI。 */
function readImageFiles(files: FileList | readonly File[]): Promise<string[]> {
  const images = Array.from(files).filter((file) =>
    file.type.startsWith('image/'),
  );
  return Promise.all(
    images.map(
      (file) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        }),
    ),
  );
}

export function InputBox({
  running,
  onSubmit,
  onStop,
  inputRef,
}: {
  readonly running: boolean;
  readonly onSubmit: (text: string, images?: readonly string[]) => void;
  readonly onStop: () => void;
  readonly inputRef?: RefObject<HTMLTextAreaElement>;
}): ReactNode {
  const [value, setValue] = useState('');
  const [pendingImages, setPendingImages] = useState<readonly string[]>([]);
  // 输入历史（↑ 召回上一条提交；Claude 式）
  const [history, setHistory] = useState<readonly string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  const ref = inputRef ?? useRef<HTMLTextAreaElement>(null);

  const showSlash = !running && value.trim().startsWith('/');
  const canSend = value.trim().length > 0 || pendingImages.length > 0;

  const submit = (): void => {
    const text = value.trim();
    if (text.length === 0 && pendingImages.length === 0) return;
    if (text.length > 0) {
      setHistory((prev) => [...prev, text].slice(-50));
    }
    setHistPos(-1);
    onSubmit(text, pendingImages);
    setValue('');
    setPendingImages([]);
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
      event.preventDefault();
      event.stopPropagation();
      onStop();
      return;
    }
    // ↑ / ↓ 召回输入历史（仅空输入框时触发，避免干扰多行编辑）
    if (event.key === 'ArrowUp' && value.length === 0 && history.length > 0) {
      event.preventDefault();
      const pos =
        histPos === -1 ? history.length - 1 : Math.max(0, histPos - 1);
      setHistPos(pos);
      setValue(history[pos]);
      return;
    }
    if (event.key === 'ArrowDown' && histPos !== -1) {
      event.preventDefault();
      if (histPos < history.length - 1) {
        const pos = histPos + 1;
        setHistPos(pos);
        setValue(history[pos]);
      } else {
        setHistPos(-1);
        setValue('');
      }
    }
  };

  /** 粘贴 / 拖拽图片：转 data URI 加入待发附件。 */
  const ingestImages = async (
    files: FileList | readonly File[],
  ): Promise<void> => {
    const uris = await readImageFiles(files);
    if (uris.length > 0) {
      setPendingImages((prev) => [...prev, ...uris]);
      if (ref.current !== null) ref.current.focus();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = event.clipboardData?.files;
    if (
      files !== undefined &&
      files.length > 0 &&
      Array.from(files).some((f) => f.type.startsWith('image/'))
    ) {
      event.preventDefault();
      void ingestImages(files);
    }
  };

  const onDrop = (event: DragEvent<HTMLTextAreaElement>): void => {
    const files = event.dataTransfer?.files;
    if (files !== undefined && files.length > 0) {
      event.preventDefault();
      void ingestImages(files);
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
            <button
              key={command.name}
              type="button"
              className="slash-chip"
              title={command.description}
              onClick={() => {
                const name = command.usage.split(' ')[0];
                setValue(name.length > 0 ? `${name} ` : command.usage);
                ref.current?.focus();
              }}
            >
              {command.usage}
            </button>
          ))}
        </div>
      )}
      {pendingImages.length > 0 && (
        <div className="image-preview-row">
          {pendingImages.map((uri, index) => (
            <div key={index} className="image-preview">
              <img src={uri} alt="待发送图片" />
              <button
                type="button"
                className="image-preview-remove"
                onClick={() =>
                  setPendingImages((prev) => prev.filter((_, i) => i !== index))
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="input-box-shell">
        <textarea
          ref={ref}
          className="input-box"
          value={value}
          rows={1}
          placeholder={
            running ? '正在运行…' : '输入任务，Enter 发送（可粘贴 / 拖拽图片）'
          }
          disabled={running}
          onChange={(event) => {
            setValue(event.target.value);
            autoGrow();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
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
        <span>Enter 发送 · Shift+Enter 换行 · 支持粘贴图片</span>
        <span>/ 开头触发斜杠命令</span>
      </div>
    </div>
  );
}
