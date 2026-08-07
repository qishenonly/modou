import type { RiskLevel } from '../protocol/events';
import { isDangerousCommand } from './danger';
import { resolveAllowedPath } from './paths';

/**
 * 权限裁决内核（T-050，design 002 6.1 正交模型，ADR 0007）。
 *
 * 沙箱范围 × 审批策略的正交九宫格，裁决顺序（002 6.1）：
 *
 *   deny 规则 > 危险命令黑名单 > 沙箱范围 > allow 规则 > 审批策略
 *
 * deny 优先级最高；危险命令即使在 `never` 策略下也强制确认——「我信任这个
 * agent」不该等于「我同意它执行 `rm -rf /`」。
 *
 * 本版矩阵实现（T-052 规则表留占位，见各函数注释）：
 *
 * |                  | untrusted        | on-request        | never                   |
 * |------------------|------------------|-------------------|-------------------------|
 * | read-only        | 读也问 / 写拒绝  | 读不问 / 写拒绝   | 静默只读 / 写拒绝       |
 * | workspace-write  | 每次写/执行都问  | 写/执行都问①      | 工作区内放手干②        |
 * | full-access      | 每次都问         | 危险操作才问③     | 完全放手（需显式开启）  |
 *
 * ① workspace-write + on-request 的矩阵语义是「模型自认风险才问」；本版工具
 *   契约没有模型风险自报通道，取保守近似 = 写/执行一律 ask，等价 0.3.0 的
 *   「写死全问」（默认组合等价性由此保证）。
 * ② workspace-write + never 只放行工作区内；目录边界（T-051，paths.ts）在
 *   沙箱范围阶段 realpath 归一后校验（跟随符号链接 / 解析 `..` / 展开 `~`），
 *   越界目标转为 ask（用户显式确认）。
 * ③ full-access + on-request 的「危险操作才问」由 ② 危险黑名单承担：非危险
 *   操作直接 allow，与 never 在本版行为一致（未来「危险」扩展时分化）。
 */

/** 沙箱范围：决定「允许在哪一类副作用上运行」。 */
export type SandboxScope = 'read-only' | 'workspace-write' | 'full-access';

/** 审批策略：决定「模型自报风险时要不要停下来问人」。 */
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';

/** 规则表条目（T-052 规则表）：命令 / 工具 / 路径前缀匹配规则。 */
export interface PermissionRule {
  /** 匹配模式（T-052 定义语法：命令前缀 / 工具名 / 路径前缀）。 */
  readonly pattern: string;
}

/** allow/deny 规则表（T-052 接口占位）。缺省空表，裁决顺序已预留。 */
export interface PermissionRules {
  readonly deny?: readonly PermissionRule[];
  readonly allow?: readonly PermissionRule[];
}

/**
 * 正交权限配置。headless / TUI 装配后注入 ApprovalGate（T-050）：
 * gate 先跑 decidePermission，allow 直通、deny 拒绝、ask 才发 approval_request。
 */
export interface PermissionConfig {
  readonly sandbox: SandboxScope;
  readonly policy: ApprovalPolicy;
  /**
   * 项目根 / 工作区根（绝对路径）：目录边界（T-051，paths.ts realpath 归一）的基准。
   * 缺省取启动 cwd；headless / TUI 用 `--add-dir` 语义扩展白名单（addDirs）。
   */
  readonly projectRoot: string;
  /** 额外允许访问的目录（--add-dir，绝对路径；paths.ts 边界校验的扩展白名单）。 */
  readonly addDirs?: readonly string[];
  /** allow/deny 规则表（T-052 接口占位，本版空表不参与裁决）。 */
  readonly rules?: PermissionRules;
}

/** 权限裁决输入（gate 从 ApprovalRequestInput 构造后传入）。 */
export interface PermissionRequest {
  readonly toolName: string;
  /** 风险分类（002 5.2 工具 risk；read/write/exec/network）。 */
  readonly risk: RiskLevel;
  /** 已校验的工具参数（管线 ② Validate 之后）：exec 取 command、写/编辑取 path。 */
  readonly args?: Readonly<Record<string, unknown>>;
}

/** 裁决结果：allow 直通 / deny 拒绝 / ask 走审批闸门。 */
export type PermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * 缺省权限组合（kickoff 0.5.0 五、开工决策）：workspace-write + on-request，
 * 替代 0.3.0 的「写死 write/exec 全问」——由 on-request 的保守近似（见文件头
 * 注释 ①）保证行为等价。
 */
export function defaultPermissionConfig(projectRoot: string): PermissionConfig {
  return { sandbox: 'workspace-write', policy: 'on-request', projectRoot };
}

/**
 * deny 规则命中判定（T-052 规则表占位）：本版空表恒不命中，但「deny 规则 >
 * 危险黑名单 > …」的裁决顺序第一位结构已就位——T-052 只需在此填入
 * 命令 / 工具 / 路径前缀的匹配实现。002 6.3：规则表是「防手滑、防模型莽撞」
 * 的深度防御一层，不是安全边界。
 */
function denyRuleHit(rules: PermissionRules | undefined): boolean {
  if (rules === undefined || (rules.deny ?? []).length === 0) return false;
  return false; // T-052：本版恒不命中（占位）
}

/**
 * allow 规则命中判定（T-052 规则表占位）：同 denyRuleHit，空表恒不命中。
 * 位置在沙箱范围之后、审批策略之前——allow 规则可放行策略层（never 放行 /
 * 记忆豁免），但不能推翻更优先的 deny 规则与沙箱范围。
 */
function allowRuleHit(rules: PermissionRules | undefined): boolean {
  if (rules === undefined || (rules.allow ?? []).length === 0) return false;
  return false; // T-052：本版恒不命中（占位）
}

/** exec 工具是否命中危险命令黑名单（T-033 danger.ts）。 */
function dangerousExec(request: PermissionRequest): boolean {
  if (request.risk !== 'exec') return false;
  const command = request.args?.command;
  return typeof command === 'string' && isDangerousCommand(command);
}

/**
 * 从工具参数取边界校验目标（T-051）：写 / 编辑工具取 path；exec 取显式 cwd（若有）；
 * 都没有则返回 undefined。
 *
 * bash 命令文本里的路径**不做静态解析**：002 6.3 诚实记录——shell 命令可以 `;` 串联、
 * `bash -c`、`eval`、变量展开、base64 解码，静态字符串匹配挡不住有意的绕过。所以本版
 * 对命令文本近似放行（只拦「显式把工作目录放到工作区外」的 cwd），真正的隔离依赖
 * 1.0.0 的 OS 级沙箱。read 类工具本版默认放行（不在边界内——矩阵 read 分支先行返回）。
 */
function boundaryTarget(request: PermissionRequest): string | undefined {
  const path = request.args?.path;
  if (typeof path === 'string') return path;
  if (request.risk === 'exec') {
    const cwd = request.args?.cwd;
    if (typeof cwd === 'string' && cwd.trim().length > 0) return cwd;
  }
  return undefined;
}

/**
 * 目录边界检查（T-051，design 002 6.2）：realpath 归一（展开 `~` / 解析 `..` /
 * 跟随符号链接 / 转绝对路径）后判断是否落在工作区根或 --add-dir 白名单内。
 * 越界 = 返回 false；无法解析（权限不足等）也按越界处理（fail-closed）。
 */
function withinWorkspace(path: string, config: PermissionConfig): boolean {
  return resolveAllowedPath(path, config).inside;
}

/**
 * 权限裁决主入口：按 002 6.1 矩阵 + 裁决顺序返回 allow / deny / ask。
 *
 * @param request 工具名 + 风险 + 已校验参数（管线 ② Validate 之后构造）
 * @param config  正交权限配置（headless / TUI 装配注入）
 */
export function decidePermission(
  request: PermissionRequest,
  config: PermissionConfig,
): PermissionDecision {
  // ① deny 规则（T-052 占位，本版空表）：优先级最高
  if (denyRuleHit(config.rules)) return 'deny';

  // ② 危险命令黑名单：命中 → 强制 ask——即使 never 策略 / read-only 沙箱也
  // 强制逐次确认（002 6.1「我信任这个 agent」≠「我同意 rm -rf /」）
  if (dangerousExec(request)) return 'ask';

  // ③ 沙箱范围：read-only 下非读操作一律拒绝（read 类除外）
  if (request.risk === 'read') {
    // 矩阵第一行：read-only + untrusted = 「读也问」；其余组合 read 不问
    return config.sandbox === 'read-only' && config.policy === 'untrusted'
      ? 'ask'
      : 'allow';
  }
  if (config.sandbox === 'read-only') return 'deny';

  // 目录边界（T-051，paths.ts realpath 归一）：在 allow 规则之前、沙箱范围阶段
  // 校验——allow 规则（T-052）可以放行审批策略层（never 放行 / 记忆豁免），但
  // **不能推翻沙箱范围**：workspace-write 下带 path 的写/执行目标越界 → 沙箱范围
  // 外（转 ask，用户显式确认）；full-access 不做边界限制；无 path 参数（bash 命令
  // 文本）近似放行（见 boundaryTarget 注释）。
  if (config.sandbox === 'workspace-write') {
    const target = boundaryTarget(request);
    if (target !== undefined && !withinWorkspace(target, config)) {
      return 'ask';
    }
  }

  // ④ allow 规则（T-052 占位，本版空表）
  if (allowRuleHit(config.rules)) return 'allow';

  // ⑤ 审批策略
  if (config.policy === 'never') {
    // workspace-write + never = 「工作区内放手干」（边界已在 ③ 校验，越界已转 ask）；
    // full-access + never = 完全放手（无边界限制）
    return 'allow';
  }
  if (config.policy === 'on-request') {
    // workspace-write + on-request = 写/执行都问（① 保守近似）；
    // full-access + on-request = 危险操作才问（危险已在 ② 强制 ask，余下放行）
    return config.sandbox === 'full-access' ? 'allow' : 'ask';
  }
  // untrusted：每次写/执行都问
  return 'ask';
}
