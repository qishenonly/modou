/**
 * 预算核算（T-062）离线测试：estimateTokens 的单调性与近似合理性、
 * BudgetLedger 的入账/校准/漂移/重建语义。
 *
 * 全部离线：不访问网络、不依赖供应商。估算的「精度」只验证近似合理
 * （中文约 1 token/字、英文约 4 字符/token），不与任何真实分词器逐 token
 * 对齐——对齐是 drift() 的职责（002 7.3）。
 */
import { describe, expect, test } from 'bun:test';
import { BudgetLedger, estimateTokens, type TokenDrift } from './budget';

// ---------------------------------------------------------------------------
// estimateTokens：字符级近似
// ---------------------------------------------------------------------------

describe('estimateTokens（轻量近似，不引重型 tokenizer）', () => {
  test('空文本与只含空白：近似 0 或极小', () => {
    expect(estimateTokens('')).toBe(0);
    // 空白也按 4 字符/token 计价（空格是 payload 的一部分）
    expect(estimateTokens('    ')).toBe(1);
  });

  test('ASCII：按 ceil(字符数 / 4)', () => {
    expect(estimateTokens('hello')).toBe(2); // ceil(5/4)
    expect(estimateTokens('hello world')).toBe(3); // ceil(11/4)
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('a'.repeat(401))).toBe(101);
  });

  test('中文：按 1 token/字符（密文种单独计价）', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('中'.repeat(100))).toBe(100);
  });

  test('混合中英：两档计价分别生效', () => {
    // 'hello'(5 拉丁) + '你好'(2 中文) → 2 + ceil(5/4) = 4
    expect(estimateTokens('hello你好')).toBe(4);
    // 'a'.repeat(400) + '你' → 100 + 1 = 101
    expect(estimateTokens('a'.repeat(400) + '你')).toBe(101);
  });

  test('日文假名 / CJK 标点 / 全角：计入密文种档', () => {
    expect(estimateTokens('あいうえお')).toBe(5); // 平假名
    expect(estimateTokens('（重要）')).toBe(4); // 全角括号
    expect(estimateTokens('「你好」')).toBe(4); // CJK 引号 + 汉字
  });

  test('emoji（代理对）按一个字符计（不崩、不按双字节膨胀）', () => {
    // '🚀' 是一个码点（代理对）；1 个拉丁档字符 → ceil(1/4) = 1
    expect(estimateTokens('🚀')).toBe(1);
  });

  test('对追加文本单调不降', () => {
    const prefixes = [
      '',
      '你好',
      'hello world',
      'const x = 1;\n',
      '{}[]<>',
      '中',
    ];
    for (const prefix of prefixes) {
      for (const suffix of ['', 'a', '你好', 'hello world', '  \n  ']) {
        expect(estimateTokens(prefix + suffix)).toBeGreaterThanOrEqual(
          estimateTokens(prefix),
        );
      }
    }
  });

  test('近似合理：长英文约 4 字符/token，长中文约 1 字符/token', () => {
    const english = 'the quick brown fox jumps over the lazy dog '.repeat(50);
    const enTokens = estimateTokens(english);
    // 1900 字符 / 4 = 475；允许 ±10% 波动（ceil 舍入与标点）
    expect(Math.abs(enTokens - english.length / 4)).toBeLessThan(
      english.length * 0.1,
    );

    const chinese = '预算核算请求前粗估响应后校准维护累计账本'.repeat(20);
    expect(estimateTokens(chinese)).toBe(chinese.length);
  });
});

// ---------------------------------------------------------------------------
// BudgetLedger：入账 / 校准 / 漂移
// ---------------------------------------------------------------------------

describe('BudgetLedger（累计账本）', () => {
  test('新账本全零', () => {
    const ledger = new BudgetLedger();
    expect(ledger.snapshot()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      noCacheTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedInput: 0,
      estimateError: 0,
    });
    expect(ledger.drift()).toEqual({
      estimated: 0,
      actual: 0,
      error: 0,
      rate: 0,
    });
  });

  test('recordUsage：以供应商 usage 为准累计各分项', () => {
    const ledger = new BudgetLedger();
    ledger.recordUsage({
      inputTokens: 100,
      outputTokens: 20,
      noCacheTokens: 60,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
    });
    ledger.recordUsage({ inputTokens: 50, outputTokens: 5 });
    expect(ledger.snapshot()).toEqual({
      inputTokens: 150,
      outputTokens: 25,
      noCacheTokens: 60,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      estimatedInput: 0,
      estimateError: 0,
    });
  });

  test('recordUsage：字段缺省（供应商未上报）按 0 计，不丢历史', () => {
    const ledger = new BudgetLedger();
    ledger.recordUsage({ inputTokens: 10 });
    ledger.recordUsage({}); // 全缺省
    ledger.recordUsage({ inputTokens: 5, outputTokens: 1 });
    expect(ledger.snapshot().inputTokens).toBe(15);
    expect(ledger.snapshot().outputTokens).toBe(1);
  });

  test('粗估入账 + 校准配对：实际以 usage 为准，偏差进入 estimateError', () => {
    const ledger = new BudgetLedger();
    ledger.recordEstimate(120); // 粗估 120
    ledger.recordUsage({ inputTokens: 100, outputTokens: 20 }); // 实测 100
    expect(ledger.snapshot().inputTokens).toBe(100); // 校准覆盖粗估：实际=100
    expect(ledger.snapshot().estimatedInput).toBe(120); // 粗估保留作偏差度量
    expect(ledger.snapshot().estimateError).toBe(20); // 120 - 100
    expect(ledger.snapshot().outputTokens).toBe(20);
  });

  test('多请求依次校准：estimatedInput / estimateError 跨请求累计', () => {
    const ledger = new BudgetLedger();
    ledger.recordEstimate(100);
    ledger.recordUsage({ inputTokens: 110 }); // 低估 10
    ledger.recordEstimate(50);
    ledger.recordUsage({ inputTokens: 40 }); // 高估 10
    expect(ledger.snapshot().estimatedInput).toBe(150);
    expect(ledger.snapshot().inputTokens).toBe(150);
    expect(ledger.snapshot().estimateError).toBe(0); // -10 + 10
  });

  test('drift()：返回粗估 vs 实测的偏差与相对率', () => {
    const ledger = new BudgetLedger();
    ledger.recordEstimate(150);
    ledger.recordUsage({ inputTokens: 100 });
    ledger.recordEstimate(60);
    ledger.recordUsage({ inputTokens: 50 });
    const drift: TokenDrift = ledger.drift();
    expect(drift.estimated).toBe(210);
    expect(drift.actual).toBe(150);
    expect(drift.error).toBe(60);
    expect(drift.rate).toBeCloseTo(60 / 150, 10); // 0.4
  });

  test('drift()：actual 为 0 时 rate 取 0（避免除零）', () => {
    const ledger = new BudgetLedger();
    ledger.recordEstimate(42);
    ledger.recordUsage({ inputTokens: 0 });
    expect(ledger.drift().rate).toBe(0);
  });

  test('forgetEstimate：请求失败丢弃待校准粗估，不影响累计漂移', () => {
    const ledger = new BudgetLedger();
    ledger.recordEstimate(80); // 请求 A：失败
    ledger.forgetEstimate();
    expect(ledger.snapshot().estimatedInput).toBe(0);
    expect(ledger.snapshot().estimateError).toBe(0);

    ledger.recordEstimate(100); // 请求 B：成功
    ledger.recordUsage({ inputTokens: 90 });
    expect(ledger.snapshot().estimatedInput).toBe(100);
    expect(ledger.snapshot().estimateError).toBe(10);
  });

  test('forgetEstimate：队列为空时幂等（防御）', () => {
    const ledger = new BudgetLedger();
    ledger.forgetEstimate();
    expect(ledger.snapshot().estimatedInput).toBe(0);
  });

  test('recordEstimate 非法值（负数 / NaN）防御性跳过', () => {
    const ledger = new BudgetLedger();
    ledger.recordEstimate(-5);
    ledger.recordEstimate(Number.NaN);
    expect(ledger.snapshot().estimatedInput).toBe(0);
    ledger.recordEstimate(10);
    ledger.recordUsage({ inputTokens: 10 });
    expect(ledger.snapshot().estimateError).toBe(0);
  });

  test('不变量：estimateError === estimatedInput - inputTokens（配对会计）', () => {
    const ledger = new BudgetLedger();
    ledger.recordEstimate(100);
    ledger.recordUsage({ inputTokens: 90 });
    ledger.recordEstimate(200);
    ledger.forgetEstimate(); // 请求失败
    ledger.recordEstimate(50);
    ledger.recordUsage({ inputTokens: 60 });
    const snap = ledger.snapshot();
    expect(snap.estimateError).toBe(snap.estimatedInput - snap.inputTokens);
  });
});

// ---------------------------------------------------------------------------
// BudgetLedger：跨会话重建
// ---------------------------------------------------------------------------

describe('BudgetLedger 跨会话重建（/resume）', () => {
  test('rebuild：从会话 usage 条目求和实际分项，粗估从零', () => {
    const ledger = BudgetLedger.rebuild([
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 },
      { inputTokens: 50, outputTokens: 5 },
    ]);
    expect(ledger.snapshot().inputTokens).toBe(150);
    expect(ledger.snapshot().outputTokens).toBe(25);
    expect(ledger.snapshot().cacheReadTokens).toBe(30);
    // 粗估不持久化：重建后从零累计（drift 是「本段会话运行期」的诊断）
    expect(ledger.snapshot().estimatedInput).toBe(0);
    expect(ledger.snapshot().estimateError).toBe(0);
  });

  test('rebuild 空条目：等价新账本', () => {
    expect(BudgetLedger.rebuild([]).snapshot()).toEqual(
      new BudgetLedger().snapshot(),
    );
  });

  test('snapshot → 构造种子：账本形态可序列化往返', () => {
    const ledger = new BudgetLedger();
    ledger.recordEstimate(120);
    ledger.recordUsage({
      inputTokens: 100,
      outputTokens: 20,
      cacheWriteTokens: 5,
    });
    const snap = ledger.snapshot();
    const restored = new BudgetLedger(snap);
    expect(restored.snapshot()).toEqual(snap);
    // 恢复后继续累计正常（实际分项接续历史）
    restored.recordUsage({ inputTokens: 10 });
    expect(restored.snapshot().inputTokens).toBe(110);
  });
});
