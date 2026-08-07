import { describe, expect, test } from 'bun:test';
import { expressCost, quote, standardCost } from '../src/shipping';
import { audit, summary, type Order } from '../src/orders';
import { discountPrice, roundPrice, taxPrice } from '../src/pricing';

/**
 * 重构行为不变的回归基线（重构评测任务的核心断言）：
 * 无论代码怎么重构，这三个模块的对外行为必须与这里完全一致。
 */
describe('shipping 行为不变（重构回归基线）', () => {
  test('standardCost 阶梯定价', () => {
    expect(standardCost(0.5)).toBe(10);
    expect(standardCost(3)).toBe(20);
    expect(standardCost(6)).toBe(23);
    expect(standardCost(10)).toBe(35);
  });

  test('expressCost 阶梯定价', () => {
    expect(expressCost(0.5)).toBe(25);
    expect(expressCost(3)).toBe(40);
    expect(expressCost(10)).toBe(65);
  });

  test('quote 委托', () => {
    expect(quote(3, false)).toBe(20);
    expect(quote(3, true)).toBe(40);
  });
});

describe('orders 行为不变（重构回归基线）', () => {
  const order: Order = {
    id: 'a1',
    total: 99,
    status: 'paid',
    reviewer: 'r',
  };

  test('summary 只含三字段', () => {
    expect(summary(order)).toEqual({ id: 'a1', total: 99, status: 'paid' });
  });

  test('audit 含全部字段', () => {
    expect(audit(order)).toEqual({
      id: 'a1',
      total: 99,
      status: 'paid',
      reviewer: 'r',
    });
  });
});

describe('pricing 行为不变（重构回归基线）', () => {
  test('金额四舍五入到分', () => {
    expect(roundPrice(10)).toBe(10);
    expect(roundPrice(12.34)).toBe(12.34);
  });

  test('折后价与含税价', () => {
    expect(discountPrice(100, 20)).toBe(80);
    expect(discountPrice(50, 10)).toBe(45);
    expect(taxPrice(100, 8)).toBe(108);
    expect(taxPrice(200, 5)).toBe(210);
  });
});
