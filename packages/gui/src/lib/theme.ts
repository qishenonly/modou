/**
 * 主题应用（外观分类）：把 GuiTheme 落到 `document.documentElement.dataset.theme`，
 * CSS 变量据此切换浅色/暗色。system = 跟随系统 prefers-color-scheme。
 */
import type { GuiTheme } from '../../electron/ipc';

/** 应用主题（含 system 解析）。 */
export function applyTheme(theme: GuiTheme): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
