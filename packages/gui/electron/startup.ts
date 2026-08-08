/**
 * GUI 启动装配（与 packages/tui/src/startup.ts 的 assembleTuiStartup 同源移植）。
 *
 * 把 core 的配置解析（loadSettings → resolveConfig）与供应商 / 权限装配收敛在
 * 这里：GuiBridge 只消费装配结果。配置优先级：内置默认 → ~/.modou/settings.json
 * → <project>/.modou/settings.json → MODOU_* 环境变量 → 显式选项（最高优先）。
 */
import { homedir } from 'node:os';
import type {
  CompactOptions,
  ConfigOverrides,
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
}

/**
 * 装配入口：加载配置并叠加 MODOU_* 环境变量与显式选项，装配 provider /
 * permission / 轮次（逻辑与 assembleTuiStartup 完全一致）。
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
    providerSpec: {
      type: (options.provider?.id as ProviderType) ?? resolved.provider,
      ...(providerBaseURL !== undefined ? { baseURL: providerBaseURL } : {}),
    },
    env,
  };
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
