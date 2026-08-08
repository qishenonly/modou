/**
 * 状态推导（与 packages/tui/src/status.tsx 同源移植，去掉 Ink）。
 *
 * GUI 主进程与渲染进程共用的纯函数：
 * - `applyUsage`：消费 usage 事件时把分项累进会话总量（002 3.2「状态栏」）；
 * - `derivePermissionMode`：从工具注册表推导权限模式（TUI 审批闸门只拦
 *   write/exec，因此存在写/执行/网络工具 =「写/执行需审批」，否则「只读」）。
 */
import type { ToolRisk, UsageData } from '@modou/core';

/** 权限模式（0.4.0 两种取值；0.5.0 策略可配后由配置摘要扩展展示）。 */
export type PermissionMode = 'readonly' | 'write-approval';

/** 权限模式的中文标签（状态栏 / 设置面板展示）。 */
export const PERMISSION_MODE_LABEL: Readonly<Record<PermissionMode, string>> = {
  readonly: '只读',
  'write-approval': '写/执行需审批',
};

/** 本会话累计 token 用量（usage 事件逐次累加；只计 token，不计费用）。 */
export interface TokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** 会话起始的零值总量（冻结，applyUsage 只读不写）。 */
export const ZERO_TOKEN_TOTALS: TokenTotals = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** 把一次 usage 事件的分项累进总量（纯函数；缺省字段按 0 计，防丢历史累计）。 */
export function applyUsage(totals: TokenTotals, usage: UsageData): TokenTotals {
  return {
    inputTokens: totals.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: totals.outputTokens + (usage.outputTokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
  };
}

/** 推导权限模式所需的工具集视图（只取 list()，避免与 ToolRegistry 全形耦合）。 */
export interface PermissionToolSource {
  readonly list: () => readonly { readonly risk: ToolRisk }[];
}

/** 从工具注册表推导权限模式（见文件头注释）。 */
export function derivePermissionMode(
  tools: PermissionToolSource,
): PermissionMode {
  const writable = tools
    .list()
    .some(
      (tool) =>
        tool.risk === 'write' ||
        tool.risk === 'exec' ||
        tool.risk === 'network',
    );
  return writable ? 'write-approval' : 'readonly';
}
