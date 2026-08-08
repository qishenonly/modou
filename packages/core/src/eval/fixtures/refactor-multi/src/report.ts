/**
 * 报表模块（多文件重构 fixture：与 invoice.ts / ledger.ts 重复了日期格式化逻辑）。
 *
 * 本文件故意把「时间戳 → YYYY-MM-DD」的格式化写了一遍（formatReportDate 内部），
 * 与 invoice.ts 的 formatInvoiceDate、ledger.ts 的 formatLedgerDate 重复——评测
 * 任务要求把该逻辑抽取到共享模块 src/datefmt.ts，三个模块复用，行为不变。
 */

/** 时间戳 → `YYYY-MM-DD`（本地时区；与 invoice/ledger 重复）。 */
export function formatReportDate(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 报表标题：`报表 <日期>`。 */
export function reportTitle(timestamp: number): string {
  return `报表 ${formatReportDate(timestamp)}`;
}
