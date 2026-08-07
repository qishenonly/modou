import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalOption,
  ApprovalResolvedData,
  ProtocolEvent,
  RiskLevel,
} from '../protocol/events';
import { isDangerousCommand } from './danger';

/**
 * 最小审批闸门（T-033，design 002 5.1 ③ Authorize 的裁决引擎）。
 *
 * 0.3.0 定位（kickoff 3.2）：本版是「**能审批**」，不是「权限系统」——写死
 * 「写入 / 执行都问一遍」，可配置正交模型（untrusted / on-request / never）与
 * allow/deny 规则表留 0.4.0（002 6.1）。read 不拦。
 *
 * 行为：
 * 1. 管线 ③ Authorize 对 `risk: 'write' | 'exec'` 的工具调用本闸门；
 * 2. 发 `approval_request` 协议事件（id / description / risk / options），然后
 *    **阻塞等待**裁决——裁决来源可注入（前端回调 / headless 策略 / 测试），
 *    0.1.0 定义的 `approve` Command 通道在此真正消费（由前端把 Command 转成
 *    decider 的 resolve）；
 * 3. 收到裁决后发 `approval_resolved` 收尾，返回裁决给管线；
 * 4. `allow_always` 记住「工具名 + 参数前缀」，本会话内同前缀不再问；
 * 5. **危险命令黑名单**（danger.ts）命中时跳过 allow_always 记忆，强制逐次确认，
 *    且审批选项不含「始终允许此前缀」——防「信任一次就永远放行危险命令」。
 *
 * 安全默认：未注入 decider 时一律拒绝（deny）——无人值守时宁可全部拦下。
 */

/** 审批请求的输入（管线 ③ Authorize 构造后传入）。 */
export interface ApprovalRequestInput {
  readonly toolName: string;
  /** 风险级别：0.3.0 只对 write / exec 调用本闸门（read 不拦）。 */
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
}

/**
 * 最小审批闸门。线程内可安全并发调用：每次 requestApproval 独立发请求 /
 * 等裁决；allow_always 记忆跨调用累积，读多写少由 Map<Set> 承载。
 */
export class ApprovalGate {
  private readonly decider: ApprovalDecider;
  /** 会话级 allow_always 记忆：工具名 → 已允许的前缀集合。 */
  private readonly allowAlwaysPrefixes = new Map<string, Set<string>>();

  constructor(options: ApprovalGateOptions = {}) {
    this.decider = options.decider ?? DEFAULT_DECIDER;
  }

  /**
   * 请求一次审批，返回裁决。管线对 `deny` 直接拦截（回可诊断错误给模型）。
   *
   * - read：0.3.0 不拦，防御性直接放行（不发事件）；
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
    if (input.risk === 'read') return 'allow_once';

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
