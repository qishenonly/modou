/**
 * 台账模块（多文件重构 fixture：与 report.ts / invoice.ts 重复了日期格式化逻辑）。
 */

/** 时间戳 → `YYYY-MM-DD`（本地时区；与 report/invoice 重复）。 */
export function formatLedgerDate(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 台账条目：`<日期> #<序号>`。 */
export function ledgerEntry(timestamp: number, seq: number): string {
  return `${formatLedgerDate(timestamp)} #${seq}`;
}
