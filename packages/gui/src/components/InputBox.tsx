/**
 * 底部输入框（Claude Desktop / Codex 式）：
 * - 圆角大输入区，自动增高；右侧圆形发送/停止按钮；
 * - 工具条（输入框内底部）：左侧「+」添加图片附件；右侧权限模式按钮
 *   （点击在输入框上方弹出选择框，切换沙箱范围 × 审批策略，保存即生效）；
 * - 粘贴 / 拖拽图片 → data URI 附件；
 * - 输入以 / 开头时提示斜杠命令。
 */
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { BUILTIN_SLASH_COMMANDS } from '../../electron/slash';

/** 权限模式预设（沙箱范围 × 审批策略，Codex 式正交）。 */
const PERM_OPTIONS: readonly {
  readonly sandbox: string;
  readonly policy: string;
  readonly label: string;
  readonly desc: string;
}[] = [
  {
    sandbox: 'read-only',
    policy: 'on-request',
    label: '只读',
    desc: '只能读取文件，不能修改或执行',
  },
  {
    sandbox: 'workspace-write',
    policy: 'untrusted',
    label: '工作区写 · 询问',
    desc: '每次写/执行都弹确认',
  },
  {
    sandbox: 'workspace-write',
    policy: 'on-request',
    label: '工作区写 · 按需',
    desc: '模型自认风险时才询问（默认）',
  },
  {
    sandbox: 'workspace-write',
    policy: 'never',
    label: '工作区写 · 不拦截',
    desc: '工作区内放手干（危险命令仍确认）',
  },
  {
    sandbox: 'full-access',
    policy: 'on-request',
    label: '完全访问',
    desc: '危险操作才问（需显式开启）',
  },
];

function permLabel(sandbox: string, policy: string): string {
  const found = PERM_OPTIONS.find(
    (option) => option.sandbox === sandbox && option.policy === policy,
  );
  if (found !== undefined) return found.label;
  const sb: Readonly<Record<string, string>> = {
    'read-only': '只读',
    'workspace-write': '工作区写',
    'full-access': '完全访问',
  };
  const pol: Readonly<Record<string, string>> = {
    untrusted: '询问',
    'on-request': '按需',
    never: '不拦截',
  };
  return `${sb[sandbox] ?? sandbox} · ${pol[policy] ?? policy}`;
}

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
  externalValue,
}: {
  readonly running: boolean;
  readonly onSubmit: (text: string, images?: readonly string[]) => void;
  readonly onStop: () => void;
  readonly inputRef?: RefObject<HTMLTextAreaElement>;
  readonly externalValue?: string;
}): ReactNode {
  const [value, setValue] = useState('');
  const [pendingImages, setPendingImages] = useState<readonly string[]>([]);
  // 任意文件附件（本地路径；文本类会被读入消息，图片按图片附件处理）
  const [pendingFiles, setPendingFiles] = useState<readonly string[]>([]);
  const [history, setHistory] = useState<readonly string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  // 权限模式（当前 sandbox/policy）+ 上拉选择框开合
  const [sandbox, setSandbox] = useState('workspace-write');
  const [policy, setPolicy] = useState('on-request');
  const [permOpen, setPermOpen] = useState(false);
  const ref = inputRef ?? useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void window.modou.getConfig().then((value) => {
      if (value !== null) {
        setSandbox(value.sandbox);
        setPolicy(value.policy);
      }
    });
  }, []);

  useEffect(() => {
    if (externalValue !== undefined) {
      setValue(externalValue);
      setHistPos(-1);
      ref.current?.focus();
    }
  }, [externalValue, ref]);

  const showSlash = !running && value.trim().startsWith('/');
  const canSend =
    value.trim().length > 0 ||
    pendingImages.length > 0 ||
    pendingFiles.length > 0;

  const submit = (): void => {
    const text = value.trim();
    if (
      text.length === 0 &&
      pendingImages.length === 0 &&
      pendingFiles.length === 0
    )
      return;
    if (text.length > 0) setHistory((prev) => [...prev, text].slice(-50));
    setHistPos(-1);
    onSubmit(text, [...pendingImages, ...pendingFiles]);
    setValue('');
    setPendingImages([]);
    setPendingFiles([]);
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
    if (event.key === 'Escape') {
      if (permOpen) {
        setPermOpen(false);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (running) {
        event.preventDefault();
        event.stopPropagation();
        onStop();
      }
    }
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

  const pickImages = (): void => {
    void window.modou.selectImages().then((uris) => {
      if (uris.length > 0) {
        setPendingImages((prev) => [...prev, ...uris]);
        if (ref.current !== null) ref.current.focus();
      }
    });
  };

  const pickFiles = (): void => {
    void window.modou.selectFiles().then((paths) => {
      if (paths.length > 0) {
        setPendingFiles((prev) => [...prev, ...paths]);
        if (ref.current !== null) ref.current.focus();
      }
    });
  };

  const switchPerm = (option: (typeof PERM_OPTIONS)[number]): void => {
    setSandbox(option.sandbox);
    setPolicy(option.policy);
    setPermOpen(false);
    void window.modou.saveSettings({
      sandbox: option.sandbox,
      policy: option.policy,
    });
  };

  const autoGrow = (): void => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="input-area">
      {/* 权限模式上拉选择框（输入框上方连接弹出，Claude/Codex 式） */}
      {permOpen && (
        <>
          <div className="perm-overlay" onClick={() => setPermOpen(false)} />
          <div className="perm-popover">
            {PERM_OPTIONS.map((option) => {
              const current =
                option.sandbox === sandbox && option.policy === policy;
              return (
                <button
                  key={option.label}
                  type="button"
                  className={`perm-option${current ? ' perm-option-current' : ''}`}
                  onClick={() => switchPerm(option)}
                >
                  <span className="perm-label">{option.label}</span>
                  <span className="perm-desc">{option.desc}</span>
                  {current && <span className="picker-tag">当前</span>}
                </button>
              );
            })}
          </div>
        </>
      )}

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

      {pendingFiles.length > 0 && (
        <div className="file-preview-row">
          {pendingFiles.map((file, index) => (
            <div key={file} className="file-preview">
              <span className="file-preview-name" title={file}>
                {file.split('/').pop() ?? file}
              </span>
              <button
                type="button"
                className="image-preview-remove"
                onClick={() =>
                  setPendingFiles((prev) => prev.filter((_, i) => i !== index))
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="input-box-shell">
        <button
          type="button"
          className="input-plus"
          onClick={pickImages}
          title="添加图片附件"
        >
          <svg
            viewBox="0 0 16 16"
            className="input-plus-icon"
            aria-hidden="true"
          >
            <path
              d="M8 3a.75.75 0 0 1 .75.75v3.5h3.5a.75.75 0 0 1 0 1.5h-3.5v3.5a.75.75 0 0 1-1.5 0v-3.5h-3.5a.75.75 0 0 1 0-1.5h3.5v-3.5A.75.75 0 0 1 8 3Z"
              fill="currentColor"
            />
          </svg>
        </button>
        <button
          type="button"
          className="input-plus"
          onClick={pickFiles}
          title="添加文件附件（文本类会被读入消息，图片按图片附件处理）"
        >
          <svg
            viewBox="0 0 16 16"
            className="input-plus-icon"
            aria-hidden="true"
          >
            <path
              d="M4 2.5h5l3 3v8H4V2.5Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <path
              d="M9 2.5v3h3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </button>
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
          onPaste={onPaste}
          onDrop={onDrop}
        />
        <button
          type="button"
          className="input-perm"
          onClick={() => setPermOpen((prev) => !prev)}
          title="切换权限模式"
        >
          {permLabel(sandbox, policy)}
          <svg
            viewBox="0 0 16 16"
            className="input-perm-chevron"
            aria-hidden="true"
          >
            <path
              d="M4.5 6.5 8 10l3.5-3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
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
        <span>
          Enter 发送 · Shift+Enter 换行 · 可粘贴/拖拽图片、➕ 添加图片或文件附件
        </span>
        <span>权限：{permLabel(sandbox, policy)}</span>
      </div>
    </div>
  );
}
