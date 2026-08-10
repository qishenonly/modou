/**
 * 自绘下拉选择（Claude/Codex 式）：
 * 原生 `<select>` 的展开列表由系统渲染、无法用 CSS 定制——这里用
 * 触发按钮 + 弹出列表完全自绘，所有下拉框统一样式。
 */
import { useState, type ReactNode } from 'react';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  /** 二级说明（显示在 label 下方，可选）。 */
  readonly desc?: string;
}

export function Select({
  value,
  options,
  onChange,
  className,
  placeholder,
}: {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly className?: string;
  readonly placeholder?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value);

  return (
    <div className={`sel${className !== undefined ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="sel-trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="sel-value">
          {current?.label ?? placeholder ?? '选择…'}
        </span>
        <svg viewBox="0 0 16 16" className="sel-chevron" aria-hidden="true">
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
      {open && (
        <>
          <div className="sel-overlay" onClick={() => setOpen(false)} />
          <div className="sel-menu" role="listbox">
            {options.map((option) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`sel-option${active ? ' sel-option-active' : ''}`}
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="sel-option-label">{option.label}</span>
                  {option.desc !== undefined && (
                    <span className="sel-option-desc">{option.desc}</span>
                  )}
                  {active && (
                    <svg
                      viewBox="0 0 16 16"
                      className="sel-check"
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
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
