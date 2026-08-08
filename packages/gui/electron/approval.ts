/**
 * 审批桥（与 packages/tui/src/approval.tsx 的 createApprovalBridge 同源移植，
 * 去掉 Ink 弹窗组件——弹窗在渲染进程，这里只留裁决桥）。
 *
 * 把渲染进程的 `approve` Command 接到 core `ApprovalGate` 的 decider 上：
 * 用户在弹窗选择 allow_once / allow_always / deny 后，App 层经 `approve`
 * Command 回传，`resolve` 让挂起的请求继续；无人裁决时一律按拒绝（deny，
 * 与 headless 同款安全默认）。
 */
import type {
  ApprovalDecision,
  ApprovalResolvedData,
  ApprovalVerdict,
  PendingApprovalRequest,
  PermissionConfig,
} from '@modou/core';
import { ApprovalGate } from '@modou/core';

/** 审批桥：把 GUI 的 `approve` Command 接到 ApprovalGate 的 decider 上。 */
export interface ApprovalBridge {
  /** 注入 `runAgentTurn` 的审批闸门（decider = 等用户从弹窗裁决）。 */
  readonly gate: ApprovalGate;
  /** 用户裁决：resolve 对应 pending 请求。返回是否命中。 */
  resolve(requestId: string, decision: ApprovalDecision): boolean;
  /** 收尾：未裁决请求一律按拒绝 resolve（退出时调用，防悬挂）。 */
  denyAll(source?: ApprovalResolvedData['source']): void;
}

/** 创建审批桥（见文件头注释）。 */
export function createApprovalBridge(
  permission?: PermissionConfig,
): ApprovalBridge {
  const pending = new Map<string, (verdict: ApprovalVerdict) => void>();
  let closed = false;

  const gate = new ApprovalGate({
    decider: (request: PendingApprovalRequest) =>
      new Promise<ApprovalVerdict>((resolve) => {
        if (closed) {
          resolve({ decision: 'deny', source: 'policy' });
          return;
        }
        pending.set(request.id, resolve);
      }),
    permission,
  });

  return {
    gate,
    resolve(requestId, decision) {
      const done = pending.get(requestId);
      if (done === undefined) return false;
      pending.delete(requestId);
      done({ decision, source: 'user' });
      return true;
    },
    denyAll(source: ApprovalResolvedData['source'] = 'policy') {
      closed = true;
      for (const done of pending.values()) {
        done({ decision: 'deny', source });
      }
      pending.clear();
    },
  };
}
