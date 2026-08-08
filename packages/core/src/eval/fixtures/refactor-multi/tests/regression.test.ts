import { describe, expect, test } from 'bun:test';
import { formatLedgerDate, ledgerEntry } from '../src/ledger';
import { formatInvoiceDate, invoiceNumber } from '../src/invoice';
import { formatReportDate, reportTitle } from '../src/report';

/**
 * 多文件重构回归基线：跨 report / invoice / ledger 三个模块的行为断言。
 * 重构必须保持本文件全部通过（行为不变）。
 */
describe('多文件重构回归基线', () => {
  const ts = new Date(2026, 0, 15).getTime(); // 2026-01-15

  test('report：日期格式化与标题', () => {
    expect(formatReportDate(ts)).toBe('2026-01-15');
    expect(reportTitle(ts)).toBe('报表 2026-01-15');
  });

  test('invoice：日期格式化与发票号', () => {
    expect(formatInvoiceDate(ts)).toBe('2026-01-15');
    expect(invoiceNumber(ts, 7)).toBe('INV-2026-01-15-7');
  });

  test('ledger：日期格式化与台账条目', () => {
    expect(formatLedgerDate(ts)).toBe('2026-01-15');
    expect(ledgerEntry(ts, 3)).toBe('2026-01-15 #3');
  });

  test('跨模块一致：三个模块对同一时间戳产出相同日期', () => {
    const report = formatReportDate(ts);
    const invoice = formatInvoiceDate(ts);
    const ledger = formatLedgerDate(ts);
    expect(report).toBe(invoice);
    expect(invoice).toBe(ledger);
  });
});
