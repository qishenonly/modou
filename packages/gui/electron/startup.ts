/**
 * GUI 启动装配（与 packages/tui/src/startup.ts 的 assembleTuiStartup 同源移植，
 * 覆盖 0.10–0.17 的配置面：快照 / 钩子 / MCP / 联网工具）。
 *
 * 把 core 的配置解析（loadSettings → resolveConfig）与供应商 / 权限装配收敛在
 * 这里：GuiBridge 只消费装配结果。配置优先级：内置默认 → ~/.modou/settings.json
 * → <project>/.modou/settings.json → MODOU_* 环境变量 → 显式选项（最高优先）。
 */
import { homedir } from 'node:os';
import type {
  CompactOptions,
  ConfigHooks,
  ConfigMcp,
  ConfigOverrides,
  ConfigSnapshot,
  ConfigWeb,
  HookBus,
  ModelProvider,
  PermissionConfig,
  ProviderFromConfigInput,
  ProviderType,
  ResolvedConfig,
  RetryOptions,
  ToolRegistry,
} from '@modou/core';
import {
  createProviderFromConfig,
  defaultHookLogDir,
  HookExecutionLog,
  hooksFromSettings,
  loadSettings,
  readOpencodeEnv,
  resolveConfig,
} from '@modou/core';

/** /model 重建 provider 实例的工厂（与 core createProviderFromConfig 同形）。 */
export type CreateProvider = (
  config: ProviderFromConfigInput,
  env: NodeJS.ProcessEnv,
) => ModelProvider;

/** GuiBridge 启动选项（core 消费面；缺省对齐 headless 安全默认）。 */
export interface GuiBridgeOptions {
  /** 装配好的模型供应商（测试注入 stub；缺省按配置装配）。 */
  readonly provider?: ModelProvider;
  /** 系统指令（缺省 buildSystemPrompt({ tools })）。 */
  readonly system?: string;
  /** 工具注册表（缺省 defaultWriteTools()——GUI 面向写/执行场景，需审批）。 */
  readonly tools?: ToolRegistry;
  /** 轮次上限（缺省经配置解析，内置默认 10）。 */
  readonly maxTurns?: number;
  /** 工作目录（缺省 process.cwd()）。 */
  readonly cwd?: string;
  /** 会话级已读文件集合（Write/Edit 防盲写的种子，透传给 core）。 */
  readonly readFiles?: ReadonlySet<string>;
  /** 用户主目录（会话/日志根；测试注入临时目录隔离）。 */
  readonly homeDir?: string;
  /** 供应商错误的退避重试参数（缺省 core 默认值）。 */
  readonly retry?: RetryOptions;
  /** 压缩配置（缺省 = 上下文窗口 70% 触发 + 生产模型生成器）。 */
  readonly compact?: CompactOptions;
  /** T-050 正交权限配置（缺省经配置解析）。 */
  readonly permission?: PermissionConfig;
  /** /model 切换时重建 provider 实例的工厂（缺省 createProviderFromConfig）。 */
  readonly createProvider?: CreateProvider;
  /** 快照配置覆盖（缺省 = settings.json snapshot 键 / 引擎内置默认）。 */
  readonly snapshot?: ConfigSnapshot;
  /** 联网工具配置覆盖（缺省 = settings.json web 键）。 */
  readonly web?: ConfigWeb;
  /** 额外技能扫描目录（GUI 配置的自定义技能根；可选）。 */
  readonly skillsDirs?: readonly string[];
}

/** assembleGuiStartup 的产出：GuiBridge 启动所需的全部装配结果。 */
export interface GuiStartupConfig {
  readonly homeDir: string;
  readonly projectRoot: string;
  readonly provider: ModelProvider;
  readonly permission: PermissionConfig;
  readonly maxTurns: number;
  readonly keepTurns: number;
  readonly providerSpec: {
    readonly type: ProviderType;
    readonly baseURL?: string;
  };
  readonly env: NodeJS.ProcessEnv;
  /** 快照配置（缺省 undefined = 引擎内置默认；0.10.0）。 */
  readonly snapshot?: ConfigSnapshot;
  /** 钩子总线（0.14.0；未配置 = undefined = 管线直通）。 */
  readonly hooks?: HookBus;
  /** 钩子配置原文（0.14.0；设置面板展示用）。 */
  readonly hooksConfig?: ConfigHooks;
  /** MCP 服务器配置原文（0.16.0；设置面板展示用）。 */
  readonly mcpConfig?: ConfigMcp;
  /** 启动期提示（0.14.0：未接线的钩子点等，runTui 以 notice 展示）。 */
  readonly notices?: readonly string[];
  /** MCP 服务器配置表（0.16.0，T-163）。 */
  readonly mcpServers: ReadonlyArray<{
    readonly name: string;
    readonly transport: 'stdio' | 'http';
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly url?: string;
    readonly enabled: boolean;
    readonly risk: string;
    readonly tools?: readonly string[];
    readonly connectTimeoutMs: number;
    readonly callTimeoutMs: number;
  }>;
  /** 联网工具配置（0.17.0，T-171/T-172）。 */
  readonly web?: ConfigWeb;
}

/**
 * 装配入口：加载配置并叠加 MODOU_* 环境变量与显式选项，装配 provider /
 * permission / 轮次 / 快照 / 钩子 / MCP / 联网（逻辑与 assembleTuiStartup 一致）。
 */
export function assembleGuiStartup(
  options: GuiBridgeOptions,
  env: NodeJS.ProcessEnv = process.env,
): GuiStartupConfig {
  const projectRoot = options.cwd ?? process.cwd();
  const bootstrapHomeDir = options.homeDir ?? homedir();
  const loaded = loadSettings({ homeDir: bootstrapHomeDir, projectRoot });
  const overrides: ConfigOverrides = {
    maxTurns: options.maxTurns,
    keepTurns: options.compact?.keepTurns,
    homeDir: options.homeDir,
    ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
    ...(options.web !== undefined ? { web: options.web } : {}),
  };
  const resolved = resolveConfig({
    settings: loaded.settings,
    homeDir: bootstrapHomeDir,
    env,
    overrides,
  });
  const opencode = readOpencodeEnv(env);
  const usedOpencode =
    resolved.model === undefined &&
    resolved.provider === 'openai-compat' &&
    opencode !== null;
  const providerBaseURL =
    options.provider !== undefined
      ? undefined
      : (resolved.baseURL ??
        (resolved.provider === 'openai-compat'
          ? usedOpencode
            ? opencode?.baseURL
            : env.OPENAI_BASE_URL
          : undefined));
  // T-143 Hooks：settings.json hooks 键 → HookBus（外部进程钩子 + 执行日志）
  const hooks =
    resolved.hooks === undefined
      ? undefined
      : buildHooks(resolved, projectRoot);
  return {
    homeDir: resolved.homeDir,
    projectRoot,
    provider:
      options.provider ??
      createProviderFromConfig(
        {
          type: resolved.provider,
          model: resolved.model,
          baseURL: resolved.baseURL,
        },
        env,
      ),
    permission:
      options.permission ?? permissionFromResolved(resolved, projectRoot),
    maxTurns: resolved.maxTurns,
    keepTurns: resolved.keepTurns,
    ...(resolved.snapshot !== undefined ? { snapshot: resolved.snapshot } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    ...(resolved.hooks !== undefined && sessionStartCount(resolved.hooks) > 0
      ? {
          notices: [
            `settings.json 配置了 ${sessionStartCount(resolved.hooks)} 个 SessionStart 钩子，但本版本未接线（仅提供挂载点）——这些钩子不会执行。`,
          ],
        }
      : {}),
    mcpServers: normalizeMcpServers(resolved.mcp),
    ...(resolved.mcp !== undefined ? { mcpConfig: resolved.mcp } : {}),
    ...(resolved.web !== undefined ? { web: resolved.web } : {}),
    ...(resolved.hooks !== undefined ? { hooksConfig: resolved.hooks } : {}),
    providerSpec: {
      type: (options.provider?.id as ProviderType) ?? resolved.provider,
      ...(providerBaseURL !== undefined ? { baseURL: providerBaseURL } : {}),
    },
    env,
  };
}

/** SessionStart 钩子计数（未接线点，配置了要提醒用户不静默）。 */
function sessionStartCount(hooks: ConfigHooks): number {
  return hooks['SessionStart']?.length ?? 0;
}

/** settings.json hooks 键 → HookBus（执行日志落 ~/.modou/logs/<project-hash>/）。 */
function buildHooks(
  resolved: ResolvedConfig,
  projectRoot: string,
): HookBus | undefined {
  return hooksFromSettings(resolved.hooks, {
    log: new HookExecutionLog({
      dir: defaultHookLogDir({ homeDir: resolved.homeDir, cwd: projectRoot }),
    }),
    cwd: projectRoot,
  });
}

/** settings.json mcp 键 → McpServerConfig 表（与 core normalizeMcpServers 同口径）。 */
function normalizeMcpServers(
  config: ConfigMcp | undefined,
): GuiStartupConfig['mcpServers'] {
  if (config === undefined) return [];
  return Object.entries(config.servers).map(([name, server]) => {
    const stdio = server.command !== undefined;
    return {
      name,
      transport: stdio ? 'stdio' : 'http',
      ...(server.command !== undefined ? { command: server.command } : {}),
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
      ...(server.url !== undefined ? { url: server.url } : {}),
      enabled: server.enabled ?? true,
      risk: server.risk ?? 'network',
      ...(server.tools !== undefined ? { tools: server.tools } : {}),
      connectTimeoutMs: server.connectTimeoutMs ?? 10_000,
      callTimeoutMs: server.callTimeoutMs ?? 120_000,
    };
  });
}

/** 配置 → PermissionConfig 的结构适配（002 2.2：Config 与 Permission 互不依赖）。 */
function permissionFromResolved(
  config: ResolvedConfig,
  projectRoot: string,
): PermissionConfig {
  return {
    sandbox: config.permission.sandbox,
    policy: config.permission.policy,
    projectRoot,
    ...(config.permission.addDirs !== undefined
      ? { addDirs: config.permission.addDirs }
      : {}),
    ...(config.permission.rules !== undefined
      ? { rules: config.permission.rules }
      : {}),
  };
}
