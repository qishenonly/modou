/**
 * 域名白名单 / 黑名单（0.17.0 T-171 WebFetch）：联网工具的目标域名过滤。
 *
 * 语义（settings.json web 键）：
 * - `deniedDomains`（黑名单）：命中即拒绝（含子域），优先于白名单——即便某域名
 *   同时出现在白名单里，黑名单一票否决；
 * - `allowedDomains`（白名单）：**非空时生效**——只允许列出的域名及其子域，
 *   其余域名一律拒绝（空/未配置 = 不限制域名，联网默认需批准由权限模型
 *   risk=network 兜底，这里是配置层的二次过滤）。
 *
 * 匹配规则：域名精确匹配或子域匹配（`example.com` 命中 `example.com` 与
 * `sub.example.com`）；大小写不敏感（hostname 统一小写）。
 *
 * 协议限制：只允许 http / https——file:// / javascript: / data: 等一律拒绝
 * （联网工具只能联网，不能把本地文件 / 伪协议当 URL 抓）。
 *
 * 模块依赖约束（002 2.2）：web 属于工具面扩展，只依赖 node 内建。
 */

/** 域名过滤配置（settings.json web 键的消费形态）。 */
export interface DomainFilterConfig {
  /** 白名单（非空时只允许这些域名及其子域）。 */
  readonly allowedDomains?: readonly string[];
  /** 黑名单（命中即拒绝，优先于白名单）。 */
  readonly deniedDomains?: readonly string[];
}

/** 域名过滤结果：ok 通过 / 拒绝（带原因，错误即数据回喂模型）。 */
export interface DomainCheckResult {
  readonly ok: boolean;
  /** 拒绝原因（ok:false 时给出，模型可据此调整策略）。 */
  readonly reason?: string;
}

/** 是否 http/https URL（联网工具只接受这两种协议）。 */
export function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** 域名是否命中规则（精确或子域；hostname 小写归一）。 */
function domainMatches(hostname: string, rule: string): boolean {
  const normalized = rule.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (hostname === normalized) return true;
  return hostname.endsWith(`.${normalized}`);
}

/**
 * 域名过滤主入口：解析 URL → 协议检查 → 黑名单 → 白名单。
 *
 * - 非 http/https 协议 → 拒绝（原因：仅支持 http/https）；
 * - 黑名单命中 → 拒绝（原因列明命中规则）；
 * - 白名单非空且未命中 → 拒绝（原因列明白名单）；
 * - 其余 → 通过。
 */
export function checkUrlDomain(
  url: string,
  config: DomainFilterConfig | undefined,
): DomainCheckResult {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: 'URL 无法解析（不是合法 URL）' };
  }
  if (!isHttpUrl(url)) {
    return {
      ok: false,
      reason: '仅支持 http/https 协议——该 URL 使用了其他协议，已拒绝',
    };
  }

  const denied = config?.deniedDomains ?? [];
  for (const rule of denied) {
    if (domainMatches(hostname, rule)) {
      return {
        ok: false,
        reason: `域名 ${hostname} 命中黑名单规则 ${rule}，已拒绝`,
      };
    }
  }

  const allowed = config?.allowedDomains ?? [];
  if (allowed.length > 0) {
    const hit = allowed.some((rule) => domainMatches(hostname, rule));
    if (!hit) {
      return {
        ok: false,
        reason: `域名 ${hostname} 不在白名单内（仅允许：${allowed.join('、')}），已拒绝`,
      };
    }
  }

  return { ok: true };
}
