/** 展示格式化（时间 / 字节 / token 数）。 */

/** 时间戳 → 相对/绝对时间文本（会话侧栏用）。 */
export function formatTime(ts: number, now: number = Date.now()): string {
  if (ts <= 0) return '—';
  const diff = now - ts;
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(ts);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** 字节数 → 可读文本（会话文件大小）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** token 数 → 千分位文本。 */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('zh-CN');
}
