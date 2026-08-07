import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalOption,
  ApprovalResolvedData,
  ProtocolEvent,
  RiskLevel,
} from '../protocol/events';
import { isDangerousCommand } from './danger';
import { decidePermission } from './policy';
import type { PermissionConfig } from './policy';

/**
 * 最小审批闸门（T-033，design 002 5.1 ③ Authorize 的裁决引擎；T-050 接入正交权限内核）。
 *
 * 0.3.0 定位是「能审批」：写死「写入 / 执行都问一遍」。T-050 把这一层替换为
 * 按 PermissionConfig 裁决（002 6.1 矩阵，ADR 0007）：
 *
 * - 注入 `permission` 时，gate 先跑 decidePermission：**allow 直通**（不发事件）、
 *   **deny 拒绝**（不发事件，管线回策略性拒绝）、**ask 才发 approval_request**；
 * - 缺省（未注入 permission）保持 0.3.0 行为：read / network 不拦、write/exec 全问，
 *   供既有调用方 / 测试保持兼容。
 *
 * 审批流程本身（ask 之后）：
 * 1. 发 `approval_request` 协议事件（id / description / risk / options），然后
 *    **阻塞等待**裁决——裁决来源可注入（前端回调 / headless 策略 / 测试）；
 * 2. 收到裁决后发 `approval_resolved` 收尾，返回裁决给管线；
 * 3. `allow_always` 记住「工具名 + 参数前缀」，本会话内同前缀不再问；
 * 4. **危险命令黑名单**（danger.ts）命中时跳过 allow_always 记忆，强制逐次确认，
 *    且审批选项不含「始终允许此前缀」——防「信任一次就永远放行危险命令」。
 *
 * 安全默认：未注入 decider 时一律拒绝（deny）——无人值守时宁可全部拦下。
 */

/** 审批请求的输入（管线 ③ Authorize 构造后传入）。 */
export interface ApprovalRequestInput {
  readonly toolName: string;
  /** 风险级别：0.3.0 只对 write / exec 调用本闸门（read 不拦）；T-050 起 read/network 也可按矩阵裁决。 */
  readonly risk: RiskLevel;
  /** 给人看 / 回喂的操作描述（如「执行命令：npm run test」）。 */
  readonly description: string;
  /** bash 命令串（危险命令黑名单检测用；非 exec 工具不提供）。 */
  readonly command?: string;
  /**
   * 记忆前缀：allow_always 的记忆键 = 工具名 + 此前缀。bash 用命令串，
   * 写 / 编辑工具用目标路径；缺省 ''（= 该工具全局放行）。
   */
  readonly prefix?: string;
  /**
   * 已校验的工具参数（T-050/T-051）：decidePermission 据 args.command 判危险、
   * 据 args.path 做目录边界 realpath 归一（跟随符号链接 / 解析 `..` / 展开 `~`）。
   * 缺省则不参与参数级裁决。
   */
  readonly args?: Readonly<Record<string, unknown>>;
}

/** 待裁决的审批请求（decider 收到的完整信息，含可选项）。 */
export interface PendingApprovalRequest {
  readonly id: string;
  readonly toolName: string;
  readonly risk: RiskLevel;
  readonly description: string;
  readonly command?: string;
  /** 本次审批的可选项（危险命令不含 allow_always）。 */
  readonly options: readonly ApprovalOption[];
}

/** 裁决结果：裁决 + 来源（protocol approval_resolved 的 source 字段）。 */
export interface ApprovalVerdict {
  readonly decision: ApprovalDecision;
  readonly source: ApprovalResolvedData['source'];
}

/** 裁决来源注入（前端回调 / headless 策略 / 测试）。 */
export type ApprovalDecider = (
  request: PendingApprovalRequest,
) => ApprovalVerdict | Promise<ApprovalVerdict>;

/** 默认裁决 = 拒绝（无人值守安全默认，002 6.1 的「能审批」写死最小护栏）。 */
const DEFAULT_DECIDER: ApprovalDecider = async () => ({
  decision: 'deny',
  source: 'policy',
});

/** 常规审批可选项（002 3.3 approve 命令的三种裁决）。 */
export const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { id: 'allow_once', label: '允许本次' },
  { id: 'allow_always', label: '始终允许此前缀' },
  { id: 'deny', label: '拒绝' },
];

/** 危险命令的可选项：不含「始终允许此前缀」（强制逐次确认）。 */
export const DANGEROUS_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { id: 'allow_once', label: '允许本次' },
  { id: 'deny', label: '拒绝' },
];

/** ApprovalGate 构造选项。 */
export interface ApprovalGateOptions {
  /** 裁决来源。缺省 = 一律拒绝（deny，source: policy）。 */
  readonly decider?: ApprovalDecider;
  /**
   * T-050 正交权限配置：提供时 gate 先跑 decidePermission（allow 直通 / deny
   * 拒绝 / ask 才发 approval_request）；缺省 = 0.3.0 行为（read/network 不拦、
   * write/exec 全问），供既有调用方兼容。
   */
  readonly permission?: PermissionConfig;
}

/**
 * 最小审批闸门。线程内可安全并发调用：每次 requestApproval 独立发请求 /
 * 等裁决；allow_always 记忆跨调用累积，读多写少由 Map<Set> 承载。
 */
export class ApprovalGate {
  private readonly decider: ApprovalDecider;
  /** T-050 正交权限配置（缺省 = 0.3.0 行为，见 requestApproval 注释）。 */
  private readonly permission: PermissionConfig | undefined;
  /** 会话级 allow_always 记忆：工具名 → 已允许的前缀集合。 */
  private readonly allowAlwaysPrefixes = new Map<string, Set<string>>();

  constructor(options: ApprovalGateOptions = {}) {
    this.decider = options.decider ?? DEFAULT_DECIDER;
    this.permission = options.permission;
  }

  /**
   * 请求一次审批，返回裁决。管线对 `deny` 直接拦截（回可诊断错误给模型）。
   *
   * T-050 起分两段：
   *
   * **第一段——权限裁决**（permission 注入时）：
   * - decidePermission 返回 `allow` → 直接放行（allow_once），不发任何事件；
   * - 返回 `deny` → 直接拒绝，不发事件（管线回「被拒绝，别重试」）；
   * - 返回 `ask` → 落入第二段审批流程。
   *
   * **第二段——审批流程**（ask 之后）：
   * - read/network 且未注入 permission（0.3.0 兼容）：防御性直接放行；
   * - 危险命令（command 命中黑名单）→ 跳过 allow_always 记忆，强制逐次确认；
   * - allow_always 记忆命中（同工具 + 前缀匹配）→ 直接放行，不发任何事件；
   * - 其余 → 发 approval_request → 阻塞等待裁决 → 发 approval_resolved 收尾。
   *
   * `emit` 是协议事件出口（管线 ⑧ Record 的 emit），缺省静默（不发事件）。
   */
  async requestApproval(
    input: ApprovalRequestInput,
    emit?: (event: ProtocolEvent) => void,
  ): Promise<ApprovalDecision> {
    // —— 第一段：按 PermissionConfig 裁决（T-050）——
    if (this.permission !== undefined) {
      const decision = decidePermission(
        {
          toolName: input.toolName,
          risk: input.risk,
          args: input.args,
        },
        this.permission,
      );
      if (decision === 'allow') return 'allow_once';
      if (decision === 'deny') return 'deny';
    } else if (input.risk === 'read' || input.risk === 'network') {
      // 0.3.0 行为：read / network 不拦（write/exec 全问）
      return 'allow_once';
    }

    // —— 第二段：审批流程（ask / 0.3.0 的 write/exec 全问）——
    const dangerous =
      input.command !== undefined && isDangerousCommand(input.command);
    const prefix = input.prefix ?? '';

    // 危险命令：跳过记忆直接强制确认（防「信任一次就永远放行危险命令」）
    if (!dangerous && this.isMemoryHit(input.toolName, prefix)) {
      return 'allow_always';
    }

    const requestId = randomUUID();
    const options = dangerous ? DANGEROUS_APPROVAL_OPTIONS : APPROVAL_OPTIONS;
    const pending: PendingApprovalRequest = {
      id: requestId,
      toolName: input.toolName,
      risk: input.risk,
      description: input.description,
      ...(input.command !== undefined ? { command: input.command } : {}),
      options,
    };

    // 发 approval_request → 阻塞等待裁决（decider 注入：前端 / headless 策略）
    if (emit !== undefined) {
      emit({
        type: 'approval_request',
        data: {
          id: requestId,
          description: pending.description,
          risk: input.risk,
          options,
        },
      });
    }

    // decider 抛错 → 视同拒绝（fail-closed）：不把异常冒泡进管线，事件仍配对
    let verdict: ApprovalVerdict;
    try {
      verdict = await this.decider(pending);
    } catch {
      verdict = { decision: 'deny', source: 'policy' };
    }

    if (emit !== undefined) {
      emit({
        type: 'approval_resolved',
        data: {
          id: requestId,
          decision: verdict.decision,
          source: verdict.source,
        },
      });
    }

    // allow_always 记忆（危险命令不记忆）
    if (verdict.decision === 'allow_always' && !dangerous) {
      this.remember(input.toolName, prefix);
    }
    return verdict.decision;
  }

  /** 记忆命中：同工具下任一已存前缀与候选前缀构成「前缀包含」关系。 */
  private isMemoryHit(toolName: string, prefix: string): boolean {
    const prefixes = this.allowAlwaysPrefixes.get(toolName);
    if (prefixes === undefined) return false;
    for (const stored of prefixes) {
      if (stored === '' ? prefix === '' : prefix.startsWith(stored)) {
        return true;
      }
    }
    return false;
  }

  private remember(toolName: string, prefix: string): void {
    let prefixes = this.allowAlwaysPrefixes.get(toolName);
    if (prefixes === undefined) {
      prefixes = new Set<string>();
      this.allowAlwaysPrefixes.set(toolName, prefixes);
    }
    prefixes.add(prefix);
  }
}
