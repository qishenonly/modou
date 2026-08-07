/**
 * 密钥脱敏（design 002 5.4）：
 *
 * 工具输出入会话日志 / 回喂模型之前，命中常见凭据形态（sk-、ghp_、私钥头、
 * AWS_SECRET…）即替换为占位符。脱敏发生在入日志之前——不能让密钥落到磁盘上
 * 的会话文件里。
 *
 * 顺序化替换，规则按「先整块、后细粒度」排列：PEM 私钥先整块替换，避免块内
 * 字段被后续规则逐条命中。占位符保留类型前缀（sk-、ghp_、AKIA…），既标明
 * 已脱敏，也不泄露密钥本身。
 */

/** 一条脱敏规则：命中即按 replace 处理。 */
export interface RedactionRule {
  readonly name: string;
  readonly regex: RegExp;
  /** 回调签名与 String.replace 一致：首个参数为整段命中，随后为捕获组。 */
  readonly replace: (match: string, key?: string) => string;
}

export interface RedactOptions {
  /** 自定义规则覆盖默认集（默认集见下）。 */
  readonly rules?: readonly RedactionRule[];
}

/** 通用占位符后缀。 */
const PLACEHOLDER = '[REDACTED]';

/** 默认脱敏规则集：常见凭据形态，按「先整块、后细粒度」排序。 */
const DEFAULT_RULES: readonly RedactionRule[] = [
  // PEM 私钥块（先整块替换，避免块内内容被逐条误处理）
  {
    name: 'private-key',
    regex:
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    replace: () => `[REDACTED_PRIVATE_KEY]`,
  },
  // OpenAI / Anthropic 风格 API key：sk- 开头 + 长随机串
  // 左边界排除 [-\\w]：避免命中 task-sk-xxx、token_sk-xxx 这类普通文本片段
  {
    name: 'api-key',
    regex: /(?<![-\\w])sk-[A-Za-z0-9_-]{16,}\b/g,
    replace: () => `sk-${PLACEHOLDER}`,
  },
  // GitHub 个人访问令牌：ghp_ / gho_ / ghu_ / ghs_ / ghr_ 开头
  {
    name: 'github-token',
    regex: /(?<![-\\w])gh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replace: () => `ghp_${PLACEHOLDER}`,
  },
  // AWS 访问密钥 ID：AKIA + 16 位大写字母数字
  {
    name: 'aws-access-key-id',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => `AKIA${PLACEHOLDER}`,
  },
  // AWS 密钥赋值：AWS_SECRET_ACCESS_KEY=xxx 之类
  {
    name: 'aws-secret-value',
    regex:
      /\b(AWS_SECRET_ACCESS_KEY|aws_secret_access_key|AWS_SESSION_TOKEN|AWS_ACCESS_KEY_ID)\s*[=:]\s*[^\s"'`]+/g,
    replace: (_match, key?: string) =>
      `${key ?? 'AWS_SECRET_ACCESS_KEY'}=${PLACEHOLDER}`,
  },
  // 通用凭据赋值：key=value / key: value 形态
  {
    name: 'generic-credential',
    regex:
      /\b(api[_-]?key|apikey|secret|token|passwd|password|client[_-]?secret)\b\s*[=:]\s*[^\s"'`]+/g,
    replace: (_match, key?: string) => `${key ?? 'secret'}=${PLACEHOLDER}`,
  },
];

/**
 * 对文本做密钥脱敏：命中默认规则集即替换为占位符。
 * 顺序应用规则（后一条规则作用于前一条的输出）。
 */
export function redactSecrets(
  text: string,
  options: RedactOptions = {},
): string {
  const rules = options.rules ?? DEFAULT_RULES;
  let result = text;
  for (const rule of rules) {
    result = result.replace(rule.regex, rule.replace);
  }
  return result;
}

/**
 * 对任意 JSON 兼容值递归脱敏（字符串字段过 redactSecrets，容器递归）。
 * 用于工具返回的结构化 payload 与 tool_call 入参——这些同样会进事件流、
 * 进日志，脱敏必须发生在入日志之前。
 * 带循环引用守卫：遇到已访问对象原样返回，避免无限递归。
 */
export function redactValue(value: unknown): unknown {
  return redactValueInternal(value, new WeakSet<object>());
}

function redactValueInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValueInternal(item, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = redactValueInternal(item, seen);
  }
  return result;
}
