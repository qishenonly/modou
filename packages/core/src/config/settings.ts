/**
 * 配置系统（design 002 九节，T-080）：分层配置解析与 schema 校验。
 *
 * 配置是给程序读的结构化设置，与给模型读的指令（AGENTS.md，T-081）分开。
 * 解析顺序（后者覆盖前者）：
 *
 *   内置默认 → ~/.modou/settings.json → <project>/.modou/settings.json
 *            → MODOU_* 环境变量 → CLI / TUI 选项
 *
 * - `loadSettings`：内置默认 + 全局 + 项目三层合并（对象深合并：permission
 *   键级覆盖；标量与数组整体替换——后者覆盖前者）。文件不存在跳过；
 *   schema 校验失败抛 `SettingsValidationError`（字段 / 期望 / 文件 / 行号）。
 * - `resolveConfig`：在文件设置之上叠加 MODOU_* 环境变量与显式覆盖
 *   （CLI / TUI 选项），产出最终配置（全部字段有确定值）。
 *
 * 模块依赖约束（002 2.2）：Config 与 Session / Permission / Provider 互不依赖，
 * 本模块只依赖 zod 与 node 内建，不 import 任何 core 其他模块。与 permission /
 * provider 的对接由调用方（TUI / runtime）做结构适配——ConfigSandbox /
 * ConfigPolicy / ConfigRule / ConfigProviderType 与 permission / provider 的
 * 类型字面量完全同形，无需类型断言即可赋值。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 类型与 schema
// ---------------------------------------------------------------------------

/** 供应商类型（与 provider 的 ProviderType 结构同形；不 import 保持模块独立）。 */
export type ConfigProviderType = 'anthropic' | 'openai-compat';

/** 沙箱范围（与 permission 的 SandboxScope 结构同形，002 6.1 正交矩阵）。 */
export type ConfigSandbox = 'read-only' | 'workspace-write' | 'full-access';

/** 审批策略（与 permission 的 ApprovalPolicy 结构同形）。 */
export type ConfigPolicy = 'untrusted' | 'on-request' | 'never';

/** 权限规则条目（与 permission 的 PermissionRule 结构同形：allow/deny 前缀匹配）。 */
export interface ConfigRule {
  readonly effect: 'allow' | 'deny';
  readonly match: string;
  readonly tool?: string;
}

// ---------------------------------------------------------------------------
// Hooks（0.14.0）：settings.json 按钩子点 + 工具匹配器注册外部进程钩子
// ---------------------------------------------------------------------------

/** 钩子工具匹配器（与 hooks 模块的 ToolMatcher 结构同形；仅 PreToolUse/PostToolUse 有意义）。 */
export interface ConfigHookMatcher {
  /** 工具名白名单；缺省或 `'*'` = 匹配全部工具（只做精确名匹配）。 */
  readonly tools?: readonly string[] | '*';
}

/**
 * 单个钩子条目（settings.json hooks 数组的元素；与 hooks 模块的
 * HookProcessSpec 结构同形——command 必填，其余可选）。
 */
export interface ConfigHookEntry {
  /** 可执行命令（绝对路径或 PATH 内命令；不支持 shell 语法——命令拆分执行）。 */
  readonly command: string;
  /** 命令行参数。 */
  readonly args?: readonly string[];
  /** 工具匹配器（仅 PreToolUse / PostToolUse 有意义；非工具点忽略）。 */
  readonly matcher?: ConfigHookMatcher;
  /** 超时（毫秒；缺省 5000）。超时按 failBehavior 降级并终止进程组。 */
  readonly timeoutMs?: number;
  /**
   * 失败降级策略（ADR 0013）：fail-open = 崩溃放行，fail-closed = 崩溃拦截。
   * 缺省按钩子点：PreToolUse（deny 语义的安全钩子）缺省 fail-closed，其余 fail-open。
   */
  readonly failBehavior?: 'fail-open' | 'fail-closed';
  /** 追加的环境变量（继承进程环境，此项覆盖）。 */
  readonly env?: Readonly<Record<string, string>>;
}

/** settings.json 的 hooks 键：四个钩子点各一个条目数组（缺省点 = 无钩子）。 */
export interface ConfigHooks {
  readonly SessionStart?: readonly ConfigHookEntry[];
  readonly UserPromptSubmit?: readonly ConfigHookEntry[];
  readonly PreToolUse?: readonly ConfigHookEntry[];
  readonly PostToolUse?: readonly ConfigHookEntry[];
}

/**
 * 快照配置（0.10.0「安全网」；缺省全部可选，引擎回落内置默认）。
 * - `enabled`：是否自动快照（缺省 true）；
 * - `maxAgeDays`：快照保留窗口（天；0 = 不限时间，缺省 30）；
 * - `keepPerSession`：每会话至少保留最近 N 条快照（缺省 10）；
 * - `maxPerProject`：每项目最多保留快照数（超限删最旧，缺省 200）；
 * - `maxChangedPaths`：单次快照降级阈值——变更路径数（缺省 2000）；
 * - `maxBytes`：单次快照降级阈值——变更文件总字节（缺省 128 MB）。
 */
export interface ConfigSnapshot {
  readonly enabled?: boolean;
  readonly maxAgeDays?: number;
  readonly keepPerSession?: number;
  readonly maxPerProject?: number;
  readonly maxChangedPaths?: number;
  readonly maxBytes?: number;
}

/** 单个钩子条目 schema（0.14.0）：command 必填，其余可选。 */
const ConfigHookEntrySchema = z
  .object({
    command: z.string().min(1, 'command 不能为空字符串'),
    args: z.array(z.string().min(1)).optional(),
    matcher: z
      .object({
        tools: z.union([z.array(z.string().min(1)), z.literal('*')]).optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z
      .number()
      .int('timeoutMs 必须是整数')
      .positive('timeoutMs 必须是正整数')
      .optional(),
    failBehavior: z.enum(['fail-open', 'fail-closed']).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** settings.json 的 hooks 键 schema（0.14.0）：四钩子点 + 工具匹配器注册。 */
const ConfigHooksSchema = z
  .object({
    SessionStart: z.array(ConfigHookEntrySchema).optional(),
    UserPromptSubmit: z.array(ConfigHookEntrySchema).optional(),
    PreToolUse: z.array(ConfigHookEntrySchema).optional(),
    PostToolUse: z.array(ConfigHookEntrySchema).optional(),
  })
  .strict()
  .optional();

/**
 * settings.json 支持项的 schema（T-080；按现有能力集，全部字段缺省可选）。
 * 顶层与 permission 均 `.strict()`：未知字段立即报错（拼写错误可见，不静默）。
 */
export const SettingsSchema = z
  .object({
    /** 供应商类型（缺省 openai-compat，回落 createProviderFromEnv 语义）。 */
    provider: z.enum(['anthropic', 'openai-compat']).optional(),
    /** 模型 ID（缺省由 provider 装配回落对应环境变量）。 */
    model: z.string().min(1).optional(),
    /** 端点前缀（openai-compat 必需；anthropic 走代理/中转时用）。 */
    baseURL: z.string().url().optional(),
    /** 权限默认（T-050 正交配置：沙箱范围 × 审批策略 + 规则表）。 */
    permission: z
      .object({
        sandbox: z
          .enum(['read-only', 'workspace-write', 'full-access'])
          .optional(),
        policy: z.enum(['untrusted', 'on-request', 'never']).optional(),
        /** 额外允许访问的目录（--add-dir 语义的配置化；绝对路径）。 */
        addDirs: z.array(z.string().min(1)).optional(),
        /** allow/deny 规则表（命令前缀 / 工具名 / 路径前缀匹配，002 6.1）。 */
        rules: z
          .array(
            z.object({
              effect: z.enum(['allow', 'deny']),
              match: z.string().min(1),
              tool: z.string().min(1).optional(),
            }),
          )
          .optional(),
      })
      .strict()
      .optional(),
    /** 轮次上限（缺省 10）。 */
    maxTurns: z.number().int().min(1).optional(),
    /** 压缩保留的近 N 轮原文（缺省 6，与 context/compact 的 DEFAULT_KEEP_TURNS 一致）。 */
    keepTurns: z.number().int().min(1).optional(),
    /** 快照配置（T-103：保留策略 / 降级阈值；缺省引擎内置默认）。 */
    snapshot: z
      .object({
        enabled: z.boolean().optional(),
        maxAgeDays: z.number().int().min(0).optional(),
        keepPerSession: z.number().int().min(1).optional(),
        maxPerProject: z.number().int().min(1).optional(),
        maxChangedPaths: z.number().int().min(1).optional(),
        maxBytes: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    /** 用户主目录：会话/日志根（缺省 os.homedir()；须为绝对路径）。 */
    homeDir: z
      .string()
      .min(1)
      .refine((value) => isAbsolute(value), { message: '期望绝对路径' })
      .optional(),
    /** Hooks（0.14.0）：按钩子点 + 工具匹配器注册外部进程钩子（缺省不挂钩子）。 */
    hooks: ConfigHooksSchema,
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;

// ---------------------------------------------------------------------------
// 内置默认（解析顺序的第一层）
// ---------------------------------------------------------------------------

/** 内置默认供应商类型（与 createProviderFromEnv('openai-compat') 对齐）。 */
export const DEFAULT_PROVIDER: ConfigProviderType = 'openai-compat';
/** 内置默认沙箱范围（与 permission 的 defaultPermissionConfig 一致）。 */
export const DEFAULT_SANDBOX: ConfigSandbox = 'workspace-write';
/** 内置默认审批策略（与 permission 的 defaultPermissionConfig 一致）。 */
export const DEFAULT_POLICY: ConfigPolicy = 'on-request';
/** 内置默认轮次上限（与 TUI 既有 `options.maxTurns ?? 10` 一致）。 */
export const DEFAULT_MAX_TURNS = 10;
/** 内置默认压缩保留轮数（不导出：与 context/compact 的 DEFAULT_KEEP_TURNS 重名，避免 export * 冲突）。 */
const DEFAULT_KEEP_TURNS = 6;

/** 内置默认设置（settings.json 各层缺省时的回落值）。 */
export const DEFAULT_SETTINGS: Settings = {
  provider: DEFAULT_PROVIDER,
  permission: { sandbox: DEFAULT_SANDBOX, policy: DEFAULT_POLICY },
  maxTurns: DEFAULT_MAX_TURNS,
  keepTurns: DEFAULT_KEEP_TURNS,
};

// ---------------------------------------------------------------------------
// 友好错误
// ---------------------------------------------------------------------------

/**
 * settings 校验失败的友好错误：字段 / 期望 / 来源（文件或环境变量）/ 行号。
 * 报错原则（002 九节）：指出具体哪个字段、期望什么、在哪个文件的第几行。
 */
export class SettingsValidationError extends Error {
  /** 出错字段（settings 命名空间下，如 `settings.maxTurns`）。 */
  readonly field: string;
  /** 期望描述（如 `期望 number` / `期望取值 "a"|"b"`）。 */
  readonly expected: string;
  /** 实际收到的值（字符串化）。 */
  readonly received?: string;
  /** 来源文件路径（环境变量错误时缺省）。 */
  readonly file?: string;
  /** 出错行号（1-based；无法定位时缺省）。 */
  readonly line?: number;
  /** 来源描述：文件路径或环境变量名。 */
  readonly source: string;

  constructor(options: {
    field: string;
    expected: string;
    received?: string;
    file?: string;
    line?: number;
    source: string;
    detail: string;
  }) {
    const where = `${options.source}${
      options.line !== undefined ? ` 第 ${options.line} 行` : ''
    }`;
    const received =
      options.received !== undefined ? `，实际收到 ${options.received}` : '';
    super(
      `配置校验失败（${where}）：字段 ${options.field} —— ${options.expected}${received}（${options.detail}）`,
    );
    this.name = 'SettingsValidationError';
    this.field = options.field;
    this.expected = options.expected;
    this.received = options.received;
    this.file = options.file;
    this.line = options.line;
    this.source = options.source;
  }
}

// ---------------------------------------------------------------------------
// 内部工具：合并与错误描述
// ---------------------------------------------------------------------------

/** 是否普通对象（settings 深合并的单位；数组不算，整体替换）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 逐层合并：对象深合并（permission 键级覆盖），标量与数组整体替换（后者覆盖前者）。 */
function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      merged[key] = deepMerge(merged[key], override[key]);
    }
    return merged;
  }
  return override;
}

/** 按路径取输入值（描述「实际收到什么」用）。 */
function valueAtPath(
  input: unknown,
  path: readonly (string | number)[],
): unknown {
  let value: unknown = input;
  for (const segment of path) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string | number, unknown>)[segment];
  }
  return value;
}

/** 把任意值描述为字符串（字符串加引号，便于与 JSON 里的书写对得上）。 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'undefined') return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 由 zod issue 构造「期望什么」的中文描述（字段类型 / 枚举取值 / 边界）。 */
function describeExpected(issue: z.ZodIssue): string {
  const raw = issue as z.ZodIssue & Record<string, unknown>;
  switch (issue.code) {
    case 'invalid_type':
      return `期望 ${String(raw.expected)}`;
    case 'invalid_value': {
      // zod 枚举错误：message 形如 "Invalid option: expected one of "a"|"b""
      const match = /expected one of (.+)$/.exec(issue.message);
      return match !== null ? `期望取值 ${match[1]}` : issue.message;
    }
    case 'invalid_format':
      return '期望 URL 格式（http/https 开头）';
    case 'too_small':
      return `期望数值 ≥ ${String(raw.minimum)}`;
    case 'too_big':
      return `期望数值 ≤ ${String(raw.maximum)}`;
    case 'unrecognized_keys':
      // zod 的 keys 是被拒绝的未知键（不是合法键）；文案列未知键本身，别把它们当期望
      return `未知字段：${(raw.keys as string[]).join('、')}（请检查拼写或参考配置说明）`;
    default:
      return issue.message;
  }
}

/** 构造报错的字段 / 期望 / 实际（unknown 键错误特判：path 为空，键在 issue.keys 里）。 */
function buildIssueSpec(
  input: unknown,
  issue: z.ZodIssue,
): { field: string; expected: string; received?: string } {
  if (issue.code === 'unrecognized_keys') {
    const keys = (issue as z.ZodIssue & { keys: string[] }).keys;
    const parent = issue.path.length > 0 ? issue.path.join('.') : '';
    return {
      field:
        parent.length > 0
          ? `settings.${parent}.${keys[0]}`
          : `settings.${keys[0]}`,
      expected: describeExpected(issue),
    };
  }
  const field = `settings${issue.path.length > 0 ? `.${issue.path.join('.')}` : ''}`;
  return {
    field,
    expected: describeExpected(issue),
    // zod 的 path 含 symbol 段（实践中不存在）；这里按 string|number 用
    received: describeValue(
      valueAtPath(input, issue.path as readonly (string | number)[]),
    ),
  };
}

/** 出错字段的叶子键（unknown 键错误取 issue.keys[0]；用于行号定位）。 */
function issueLeafKey(issue: z.ZodIssue): string | undefined {
  if (issue.code === 'unrecognized_keys') {
    return (issue as z.ZodIssue & { keys: string[] }).keys[0];
  }
  return [...issue.path]
    .reverse()
    .find((segment) => typeof segment === 'string');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 在 JSON 文本里定位字段所在行（找叶子键的 `"key":` 形态；定位失败返回 undefined）。 */
function findFieldLine(
  text: string,
  leaf: string | undefined,
): number | undefined {
  if (leaf === undefined) return undefined;
  const pattern = new RegExp(`"${escapeRegExp(leaf)}"\\s*:`);
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) return index + 1;
  }
  return undefined;
}

/** 窄化 Node 错误对象（读取 ErrnoException.code 用）。 */
function isErrno(cause: unknown): cause is { code?: string } {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code !== undefined
  );
}

/**
 * 定位 JSON 语法错误所在行（1-based）。bun 的 JSON.parse 错误不带位置信息，
 * 这里用一个轻量递归下降扫描器在失败时给出首个错误所在行；合法 JSON 返回 null
 * （只在 JSON.parse 已失败时调用，能解析就不进来）。
 */
function findJsonErrorLine(text: string): number | null {
  let index = 0;
  let line = 1;

  const atEnd = (): boolean => index >= text.length;
  const ch = (): string => text[index] ?? '';
  const advance = (): string => {
    const c = ch();
    if (c === '\n') line += 1;
    index += 1;
    return c;
  };
  const skipWs = (): void => {
    while (!atEnd() && /\s/.test(ch())) void advance();
  };

  // 解析函数成功返回 true、失败返回 false；失败时的行号已记录在 `line`，
  // 逐层 return false 不再推进指针，顶层 `line` 即首个错误所在行。
  const parseString = (): boolean => {
    while (!atEnd()) {
      const c = advance();
      if (c === '"') return true;
      if (c === '\\') {
        if (atEnd()) return false;
        void advance();
      } else if (c === '\n') {
        return false; // 字符串内不允许裸换行
      }
    }
    return false; // 未闭合字符串
  };

  const parseNumber = (): boolean => {
    while (!atEnd() && /[0-9eE+\-.]/.test(ch())) void advance();
    return true;
  };

  const parseLiteral = (literal: string): boolean => {
    for (const expected of literal) {
      if (ch() !== expected) return false;
      void advance();
    }
    return true;
  };

  const parseArray = (): boolean => {
    void advance(); // '['
    skipWs();
    if (ch() === ']') {
      void advance();
      return true;
    }
    for (;;) {
      if (!parseValue()) return false;
      skipWs();
      const c = ch();
      if (c === ',') {
        void advance();
        skipWs();
        continue;
      }
      if (c === ']') {
        void advance();
        return true;
      }
      return false;
    }
  };

  const parseObject = (): boolean => {
    void advance(); // '{'
    skipWs();
    if (ch() === '}') {
      void advance();
      return true;
    }
    for (;;) {
      skipWs();
      if (ch() !== '"') return false; // 键必须是字符串
      void advance();
      if (!parseString()) return false;
      skipWs();
      if (ch() !== ':') return false;
      void advance();
      if (!parseValue()) return false;
      skipWs();
      const c = ch();
      if (c === ',') {
        void advance();
        continue;
      }
      if (c === '}') {
        void advance();
        return true;
      }
      return false;
    }
  };

  const parseValue = (): boolean => {
    skipWs();
    const c = ch();
    if (c === '') return false;
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') {
      void advance();
      return parseString();
    }
    if (c === 't') return parseLiteral('true');
    if (c === 'f') return parseLiteral('false');
    if (c === 'n') return parseLiteral('null');
    if (c === '-' || /[0-9]/.test(c)) {
      void advance();
      return parseNumber();
    }
    void advance();
    return false;
  };

  if (!parseValue()) return line;
  skipWs();
  return atEnd() ? null : line; // 合法值之后还有内容 = 语法错误
}

// ---------------------------------------------------------------------------
// 文件加载
// ---------------------------------------------------------------------------

/** loadSettings 入参：两个设置文件的定位基准。 */
export interface LoadSettingsOptions {
  /** 引导主目录：全局设置文件位于 `<homeDir>/.modou/settings.json`。 */
  readonly homeDir: string;
  /** 项目根：项目级设置文件位于 `<projectRoot>/.modou/settings.json`。 */
  readonly projectRoot: string;
}

/** loadSettings 产出：内置默认 + 全局 + 项目三层合并后的设置。 */
export interface LoadSettingsResult {
  /** 合并后的设置（含内置默认；项目覆盖全局、全局覆盖默认）。 */
  readonly settings: Settings;
  /** 全局设置文件路径（文件不存在 = undefined）。 */
  readonly globalFile?: string;
  /** 项目设置文件路径（文件不存在 = undefined）。 */
  readonly projectFile?: string;
}

/** 读取并解析一个 settings.json；文件不存在返回 null，JSON 语法错误抛友好错误。 */
function readSettingsFile(
  file: string,
): { value: unknown; text: string } | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    if (isErrno(cause) && cause.code === 'ENOENT') return null; // 文件不存在跳过
    throw cause;
  }
  try {
    return { value: JSON.parse(text), text };
  } catch (cause) {
    const line = findJsonErrorLine(text);
    throw new SettingsValidationError({
      field: 'settings',
      expected: '期望合法 JSON 对象',
      file,
      source: file,
      ...(line !== null ? { line } : {}),
      detail: `JSON 解析失败：${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
}

/** 校验单个文件内容；schema 失败时抛字段 / 期望 / 文件 / 行号齐全的友好错误。 */
function validateFile(
  loaded: { value: unknown; text: string },
  file: string,
): Settings {
  const parsed = SettingsSchema.safeParse(loaded.value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const spec = buildIssueSpec(loaded.value, issue);
  const line = findFieldLine(loaded.text, issueLeafKey(issue));
  throw new SettingsValidationError({
    field: spec.field,
    expected: spec.expected,
    ...(spec.received !== undefined ? { received: spec.received } : {}),
    file,
    source: file,
    ...(line !== undefined ? { line } : {}),
    detail: issue.message,
  });
}

/**
 * 加载并合并设置（解析顺序的前三层：内置默认 → 全局 → 项目）。
 * 文件不存在跳过；schema 校验失败抛 SettingsValidationError（友好报错）。
 */
export function loadSettings(options: LoadSettingsOptions): LoadSettingsResult {
  const globalFile = join(options.homeDir, '.modou', 'settings.json');
  const projectFile = join(options.projectRoot, '.modou', 'settings.json');

  let merged: unknown = DEFAULT_SETTINGS;
  let hasGlobal = false;
  let hasProject = false;

  const globalLoaded = readSettingsFile(globalFile);
  if (globalLoaded !== null) {
    hasGlobal = true;
    merged = deepMerge(merged, validateFile(globalLoaded, globalFile));
  }
  const projectLoaded = readSettingsFile(projectFile);
  if (projectLoaded !== null) {
    hasProject = true;
    merged = deepMerge(merged, validateFile(projectLoaded, projectFile));
  }

  // 各层各自合法，合并结果结构仍合法；重新 parse 归一为类型化 Settings
  // （zod v4 输出省略缺席的可选键，保证 merged 不含 undefined 键）。
  const settings = SettingsSchema.parse(merged);
  return {
    settings,
    ...(hasGlobal ? { globalFile } : {}),
    ...(hasProject ? { projectFile } : {}),
  };
}

// ---------------------------------------------------------------------------
// 环境变量（MODOU_*）与最终解析
// ---------------------------------------------------------------------------

/** 字段路径 → 环境变量名（友好报错时指名哪个变量）。 */
const PATH_TO_ENV: Record<string, string> = {
  provider: 'MODOU_PROVIDER',
  model: 'MODOU_MODEL',
  baseURL: 'MODOU_BASE_URL',
  'permission.sandbox': 'MODOU_SANDBOX',
  'permission.policy': 'MODOU_POLICY',
  'permission.addDirs': 'MODOU_ADD_DIRS',
  maxTurns: 'MODOU_MAX_TURNS',
  keepTurns: 'MODOU_KEEP_TURNS',
  homeDir: 'MODOU_HOME_DIR',
};

/** 由 zod issue 反查来源环境变量名（未知键错误退化到 MODOU_*）。 */
function envVarForIssue(issue: z.ZodIssue): string {
  if (issue.code === 'unrecognized_keys') return 'MODOU_*';
  const key = issue.path.join('.');
  return PATH_TO_ENV[key] ?? `MODOU_${key.toUpperCase().replace(/\./g, '_')}`;
}

/**
 * 环境变量 → 设置补丁（MODOU_*；取值非法时抛 SettingsValidationError，
 * 报错指明来源变量名）。无 MODOU_* 配置时返回空设置。
 */
function envToSettings(env: NodeJS.ProcessEnv): Settings {
  const patch: Record<string, unknown> = {};
  const put = (
    target: Record<string, unknown>,
    key: string,
    value: string | undefined,
  ): void => {
    if (value !== undefined && value.trim() !== '') target[key] = value;
  };
  put(patch, 'provider', env.MODOU_PROVIDER);
  put(patch, 'model', env.MODOU_MODEL);
  put(patch, 'baseURL', env.MODOU_BASE_URL);
  put(patch, 'homeDir', env.MODOU_HOME_DIR);
  if (env.MODOU_MAX_TURNS !== undefined && env.MODOU_MAX_TURNS.trim() !== '') {
    patch.maxTurns = Number(env.MODOU_MAX_TURNS);
  }
  if (
    env.MODOU_KEEP_TURNS !== undefined &&
    env.MODOU_KEEP_TURNS.trim() !== ''
  ) {
    patch.keepTurns = Number(env.MODOU_KEEP_TURNS);
  }
  const permPatch: Record<string, unknown> = {};
  put(permPatch, 'sandbox', env.MODOU_SANDBOX);
  put(permPatch, 'policy', env.MODOU_POLICY);
  if (env.MODOU_ADD_DIRS !== undefined && env.MODOU_ADD_DIRS.trim() !== '') {
    permPatch.addDirs = env.MODOU_ADD_DIRS.split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (Object.keys(permPatch).length > 0) patch.permission = permPatch;

  if (Object.keys(patch).length === 0) return {};
  const parsed = SettingsSchema.safeParse(patch);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const spec = buildIssueSpec(patch, issue);
  throw new SettingsValidationError({
    field: spec.field,
    expected: spec.expected,
    ...(spec.received !== undefined ? { received: spec.received } : {}),
    source: envVarForIssue(issue),
    detail: issue.message,
  });
}

/** CLI / TUI 选项面（最高优先级；显式传 undefined 不覆盖低层值）。 */
export interface ConfigOverrides {
  readonly provider?: ConfigProviderType;
  readonly model?: string;
  readonly baseURL?: string;
  readonly sandbox?: ConfigSandbox;
  readonly policy?: ConfigPolicy;
  readonly addDirs?: readonly string[];
  readonly rules?: readonly ConfigRule[];
  readonly maxTurns?: number;
  readonly keepTurns?: number;
  readonly snapshot?: ConfigSnapshot;
  readonly homeDir?: string;
  /** Hooks（0.14.0）：显式覆盖 settings.json 的 hooks 键（最高优先级）。 */
  readonly hooks?: ConfigHooks;
}

/** resolveConfig 入参。 */
export interface ResolveConfigInput {
  /** 已从 settings.json 合并的设置（loadSettings 的产出；缺省空，回落内置默认）。 */
  readonly settings?: Settings;
  /** 引导主目录（全局 settings.json 的基准；缺省 os.homedir()）。 */
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** CLI / TUI 选项覆盖（最高优先级）。 */
  readonly overrides?: ConfigOverrides;
}

/** 最终权限配置（字面量与 permission 的 PermissionConfig 同形，可直接装配）。 */
export interface ResolvedPermission {
  readonly sandbox: ConfigSandbox;
  readonly policy: ConfigPolicy;
  readonly addDirs?: readonly string[];
  readonly rules?: readonly ConfigRule[];
}

/** resolveConfig 的最终产出：全部字段有确定值（含内置默认回落）。 */
export interface ResolvedConfig {
  readonly provider: ConfigProviderType;
  readonly model?: string;
  readonly baseURL?: string;
  readonly permission: ResolvedPermission;
  readonly maxTurns: number;
  readonly keepTurns: number;
  readonly snapshot?: ConfigSnapshot;
  readonly homeDir: string;
  /** Hooks（0.14.0）：settings.json / 显式覆盖合并后的钩子配置（缺省无钩子）。 */
  readonly hooks?: ConfigHooks;
}

/**
 * 解析最终配置（解析顺序的完整链条）：
 * 内置默认 → settings.json（全局+项目）→ MODOU_* 环境变量 → 显式覆盖。
 * 覆盖按「后者覆盖前者」，逐字段独立取第一个非 undefined 值。
 */
export function resolveConfig(input: ResolveConfigInput = {}): ResolvedConfig {
  const env = input.env ?? process.env;
  const envSettings = envToSettings(env);
  let settings = input.settings ?? {};
  if (Object.keys(envSettings).length > 0) {
    settings = deepMerge(settings, envSettings) as Settings;
  }
  const overrides = input.overrides ?? {};
  const permission = settings.permission;
  const sandbox = overrides.sandbox ?? permission?.sandbox ?? DEFAULT_SANDBOX;
  const policy = overrides.policy ?? permission?.policy ?? DEFAULT_POLICY;
  const addDirs = overrides.addDirs ?? permission?.addDirs;
  const rules = overrides.rules ?? permission?.rules;
  return {
    provider: overrides.provider ?? settings.provider ?? DEFAULT_PROVIDER,
    model: overrides.model ?? settings.model,
    baseURL: overrides.baseURL ?? settings.baseURL,
    permission: {
      sandbox,
      policy,
      ...(addDirs !== undefined ? { addDirs } : {}),
      ...(rules !== undefined ? { rules } : {}),
    },
    maxTurns: overrides.maxTurns ?? settings.maxTurns ?? DEFAULT_MAX_TURNS,
    keepTurns: overrides.keepTurns ?? settings.keepTurns ?? DEFAULT_KEEP_TURNS,
    ...((overrides.snapshot ?? settings.snapshot) !== undefined
      ? { snapshot: overrides.snapshot ?? settings.snapshot }
      : {}),
    ...((overrides.hooks ?? settings.hooks) !== undefined
      ? { hooks: overrides.hooks ?? settings.hooks }
      : {}),
    homeDir:
      overrides.homeDir ?? settings.homeDir ?? input.homeDir ?? homedir(),
  };
}
