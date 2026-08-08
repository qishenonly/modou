import { describe, expect, test } from 'bun:test';
import { checkUrlDomain, isHttpUrl } from './domain';

/**
 * 域名白名单 / 黑名单（0.17.0 T-171 WebFetch）：协议限制 + 黑名单优先 + 白名单非空即生效。
 */
describe('isHttpUrl', () => {
  test('只接受 http/https', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/plain;base64,x')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});

describe('checkUrlDomain', () => {
  test('无配置 = 通过（联网默认需批准由权限模型兜底）', () => {
    expect(checkUrlDomain('https://example.com', undefined).ok).toBe(true);
  });

  test('非 http/https 协议拒绝', () => {
    const result = checkUrlDomain('file:///etc/passwd', {});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('http/https');
  });

  test('黑名单命中拒绝（精确 + 子域），优先于白名单', () => {
    const config = {
      allowedDomains: ['example.com'],
      deniedDomains: ['evil.example.com'],
    };
    expect(checkUrlDomain('https://evil.example.com/x', config).ok).toBe(false);
    // 黑名单命中即使同时在白名单内也拒绝
    expect(
      checkUrlDomain('https://sub.evil.example.com', {
        allowedDomains: ['evil.example.com'],
        deniedDomains: ['evil.example.com'],
      }).ok,
    ).toBe(false);
  });

  test('白名单非空 = 只允许列出域名及其子域', () => {
    const config = { allowedDomains: ['example.com', 'docs.modou.dev'] };
    expect(checkUrlDomain('https://example.com', config).ok).toBe(true);
    expect(checkUrlDomain('https://sub.example.com/x', config).ok).toBe(true);
    expect(checkUrlDomain('https://docs.modou.dev', config).ok).toBe(true);
    const denied = checkUrlDomain('https://evil.org', config);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain('白名单');
  });

  test('白名单未配置（空数组/缺省）= 不限制域名', () => {
    expect(
      checkUrlDomain('https://anything.dev', { allowedDomains: [] }).ok,
    ).toBe(true);
    expect(checkUrlDomain('https://anything.dev', {}).ok).toBe(true);
  });

  test('大小写不敏感', () => {
    expect(
      checkUrlDomain('https://EXAMPLE.COM/x', {
        allowedDomains: ['example.com'],
      }).ok,
    ).toBe(true);
  });
});
