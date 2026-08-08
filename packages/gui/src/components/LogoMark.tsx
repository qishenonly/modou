/**
 * modou 品牌标（Claude Desktop 式）：橙色圆角方块 + 白色火花标记。
 * 尺寸自适应（width/height prop），用于侧栏、空状态与消息头像。
 */
import type { ReactNode } from 'react';

export function LogoMark({
  size = 28,
  className,
}: {
  readonly size?: number;
  readonly className?: string;
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="modou"
    >
      <rect width="32" height="32" rx="8" fill="#D97757" />
      {/* 八芒火花（Claude 式） */}
      <path
        d="M16 6.5c.9 3.9 2.9 5.9 6.8 6.8-3.9.9-5.9 2.9-6.8 6.8-.9-3.9-2.9-5.9-6.8-6.8 3.9-.9 5.9-2.9 6.8-6.8Z"
        fill="#fff"
      />
      <circle cx="16" cy="16" r="2.1" fill="#fff" />
    </svg>
  );
}
