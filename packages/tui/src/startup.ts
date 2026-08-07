/**
 * TUI 启动装配（T-080 配置系统接入）。
 *
 * 把 core 的配置解析（loadSettings → resolveConfig）与供应商 / 权限装配收敛
 * 在这里：runTui 只消费装配结果（assembleTuiStartup 的产出），测试直接调本
 * 函数离线验证「settings.json + 环境变量 → 装配」。homeDir / projectRoot 由
 * 调用方注入（测试用临时目录隔离，不读写真实用户目录）。
 */
import { EventEmitter } from 'node:events';
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

/**
 * runTui 选项（T-040 骨架）。
 *
 * provider / system / tools / maxTurns / cwd / readFiles / retry 与 headless 同形，
 * 由 cli 装配或测试注入；缺省值尽量对齐 headless 的安全默认。0.8.0 起
 * maxTurns / keepTurns / homeDir / provider / permission 的缺省均经配置系统
 * 解析（T-080）：内置默认 → ~/.modou/settings.json → <project>/.modou/settings.json
 * → MODOU_* 环境变量 → 本选项（最高优先）。
 */
export interface TuiOptions {
  /** 装配好的模型供应商（测试注入 stub；缺省按配置装配，未配置回落 createProviderFromEnv）。 */
  readonly provider?: ModelProvider;
  /**
   * 首个提示词：提供时自动提交（等价 `modou "任务"`，但走 TUI 渲染）。
   * 缺省则进入交互模式，等用户在输入行敲回车。
   */
  readonly prompt?: string;
  /** 系统指令（缺省 buildSystemPrompt({ tools })）。 */
  readonly system?: string;
  /**
   * 工具注册表（缺省 defaultReadonlyTools()——只读安全默认）。
   * 注入写 / 执行工具后，write / exec 调用会经 ApprovalGate 发 approval_request，
   * 由审批弹窗（T-044）裁决——用户选 allow_once / allow_always / deny 后经
   * `approve` Command 回传；无人裁决时按默认拒绝（deny，与 headless 同款安全
   * 默认）。危险命令（rm -rf 等黑名单）仍由 core 强制逐次确认。
   */
  readonly tools?: ToolRegistry;
  /** 轮次上限（缺省经配置解析，内置默认 10）。 */
  readonly maxTurns?: number;
  /** 会话级已读文件集合（Write/Edit 防盲写的种子，透传给 core）。 */
  readonly readFiles?: ReadonlySet<string>;
  /** 工作目录（缺省 process.cwd()，相对路径以此解析）。 */
  readonly cwd?: string;
  /**
   * 用户主目录：会话日志根为 `<homeDir>/.modou/sessions/<project-hash>`
   * （T-060/T-061；缺省 os.homedir()）。测试注入临时目录隔离。
   */
  readonly homeDir?: string;
  /** 供应商错误的退避重试参数（缺省用 core 默认值）。 */
  readonly retry?: RetryOptions;
  /**
   * 压缩配置（T-070 /compact）：覆盖 runTui 的压缩缺省（阈值 / 保留轮数 /
   * 迟滞窗口）。`generateDelta` 缺省 = `createModelDeltaGenerator(provider)`
   * （生产由模型生成增量）；测试注入 stub 以离线覆盖。`thresholdTokens` 缺省
   * = `maxContext × 0.7`（约 70% 上下文窗口触发）。缺省 = 启用压缩（自动触发
   * + `/compact` 手动命令）。
   */
  readonly compact?: CompactOptions;
  /**
   * T-050 正交权限配置（沙箱范围 × 审批策略）。缺省经配置解析（内置默认 =
   * workspace-write + on-request，defaultPermissionConfig 语义，projectRoot 取
   * cwd）——由 on-request 的保守近似等价 0.3.0「写死 write/exec 全问」；弹窗只
   * 裁决 ask 之后的请求，矩阵中的 allow / deny 由 gate 内部直接裁决（弹窗不出现）。
   */
  readonly permission?: PermissionConfig;
  /** Ink 输出流（测试注入；缺省 process.stdout）。 */
  readonly stdout?: NodeJS.WriteStream;
  /** Ink 输入流（测试注入；缺省 process.stdin）。 */
  readonly stdin?: NodeJS.ReadStream;
  /** 信号源（测试注入 EventEmitter；缺省 process）。 */
  readonly signalEmitter?: EventEmitter;
  /**
   * /model 切换（T-082）时重建 provider 实例的工厂。缺省 =
   * createProviderFromConfig（按装配面的 type / model / baseURL + 环境变量
   * 重建；002 8.2「换 provider 实例」）。测试注入 stub 以离线覆盖（不访问
   * 外网、不读真实环境变量）。/resume 恢复会话模型时同样走本工厂。
   */
  readonly createProvider?: CreateProvider;
}

/** assembleTuiStartup 的产出：runTui 启动所需的全部装配结果。 */
export interface TuiStartupConfig {
  /** 生效主目录（settings.homeDir 可覆盖注入值；会话/日志根）。 */
  readonly homeDir: string;
  /** 项目根（目录边界 / 项目 settings.json 的基准）。 */
  readonly projectRoot: string;
  /** 装配好的模型供应商（显式 options.provider 优先，否则按配置装配）。 */
  readonly provider: ModelProvider;
  /** 权限配置（显式 options.permission 优先，否则按配置装配）。 */
  readonly permission: PermissionConfig;
  /** 轮次上限（配置解析后的最终值）。 */
  readonly maxTurns: number;
  /** 压缩保留的近 N 轮原文（配置解析后的最终值）。 */
  readonly keepTurns: number;
  /**
   * provider 装配面（T-082 /model 重建 provider 实例用）：供应商类型 +
   * 生效端点。baseURL 取「配置显式值 → opencode 测试端点 → OPENAI_BASE_URL」，
   * 与装配时的 createProviderFromConfig 分支同口径；options.provider 注入时
   * 无装配面（undefined），/model 回落环境变量。
   */
  readonly providerSpec: {
    readonly type: ProviderType;
    readonly baseURL?: string;
  };
  /** 装配时使用的环境（/model 重建 provider 时沿用同一环境）。 */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * T-080 装配入口：加载配置（内置默认 → 全局 → 项目 settings.json），
 * 叠加 MODOU_* 环境变量与显式选项，装配 provider / permission / 轮次。
 *
 * - provider：显式 options.provider 实例优先；否则按配置（type + model +
 *   baseURL）经 createProviderFromConfig 装配（API Key 回落环境变量）；
 * - permission：显式 options.permission 优先；否则按配置的沙箱范围 × 审批
 *   策略 + 规则表装配（projectRoot 取 cwd，目录边界基准）；
 * - maxTurns / keepTurns / homeDir：配置解析的最终值。
 */
export function assembleTuiStartup(
  options: TuiOptions,
  env: NodeJS.ProcessEnv = process.env,
): TuiStartupConfig {
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
  // provider 装配面（T-082 /model 重建用）：baseURL 与装配时的
  // createProviderFromConfig 分支同口径——openai-compat 且未配置 model 时
  // 优先 opencode 测试端点，否则配置显式值 / OPENAI_BASE_URL 回落环境变量。
  const opencode = readOpencodeEnv(env);
  const usedOpencode =
    resolved.model === undefined &&
    resolved.provider === 'openai-compat' &&
    opencode !== null;
  const providerBaseURL =
    options.provider !== undefined
      ? undefined // 注入的 provider 无装配面：/model 回落环境变量
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

/**
 * 配置 → PermissionConfig 的结构适配（002 2.2：Config 与 Permission 互不依赖，
 * 由消费者做转换）。ConfigSandbox / ConfigPolicy / ConfigRule 与 permission 的
 * 类型字面量完全同形，无需断言。
 */
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
