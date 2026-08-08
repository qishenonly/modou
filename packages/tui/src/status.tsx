/**
 * 状态栏（T-045 最小版）：模型名、权限模式、本会话累计 token、运行状态。
 *
 * ## 分工
 *
 * - `ZERO_TOKEN_TOTALS` / `applyUsage`：纯函数 token 累计——App 消费 `usage`
 *   事件时把当次请求的 token 分项累进会话总量（002 3.2「usage：本次请求 token
 *   分项…状态栏」）。完整 `/context` 分项视图在 0.6.0，本版只做累计，不做核算；
 * - `derivePermissionMode`：从工具注册表推导权限模式。TUI 的审批闸门（T-044）
 *   只拦截 write / exec（read 不拦），因此注册表里存在写/执行/网络工具时 =
 *   「写/执行需审批」，否则 =「只读」。0.4.0 只有这两种；0.5.0 权限策略可配
 *   之后再扩展取值；
 * - `StatusBar`：渲染组件。纯展示——所有状态由 App 层持有（模型名/权限模式由
 *   runTui 注入，totals / running / turn 由事件流推导），本组件不订阅事件。
 *
 * 布局：单行，段之间用「 · 」分隔；未注入的段（模型名 / 权限模式）自动跳过，
 * 保证 App 在测试或独立渲染时缺省也能显示运行状态与 token。
 */
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ToolRisk, UsageData } from '@modou/core';

/** 权限模式（0.4.0 最小版两种取值；0.5.0 策略可配后再扩展）。 */
export type PermissionMode = 'readonly' | 'write-approval';

/** 权限模式的中文标签（状态栏展示，与 kickoff 3.4 文案一致）。 */
export const PERMISSION_MODE_LABEL: Readonly<Record<PermissionMode, string>> = {
  readonly: '只读',
  'write-approval': '写/执行需审批',
};

/** 本会话累计 token 用量（消费 usage 事件逐次累加；最小版只计 token，不计费用）。 */
export interface TokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 缓存命中的输入 token（供应商上报时才有值；可选显示） */
  readonly cacheReadTokens: number;
  /** 写入缓存的输入 token（供应商上报时才有值；备用，暂不展示） */
  readonly cacheWriteTokens: number;
}

/** 会话起始的零值总量（冻结，applyUsage 只读不写）。 */
export const ZERO_TOKEN_TOTALS: TokenTotals = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/**
 * 把一次 usage 事件的分项累进会话总量（纯函数，无副作用）。
 *
 * UsageData 的字段全可选（供应商未上报时为 undefined）：缺省字段按 0 计，
 * 避免「这次缺了就丢掉历史累计」的脏行为。返回全新对象，绝不改传入总量。
 */
export function applyUsage(totals: TokenTotals, usage: UsageData): TokenTotals {
  return {
    inputTokens: totals.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: totals.outputTokens + (usage.outputTokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
  };
}

/**
 * 推导权限模式所需的工具集视图：只取 `list()`，避免与 ToolRegistry 全形耦合
 * （ToolRegistry 结构上满足此接口，测试也能用极简 stub 注入）。
 */
export interface PermissionToolSource {
  readonly list: () => readonly { readonly risk: ToolRisk }[];
}

/**
 * 从工具注册表推导权限模式：含写/执行/网络风险工具 →「写/执行需审批」，
 * 否则（只有读工具或空注册表）→「只读」。对应 T-044 审批闸门的实际行为——
 * write / exec 会被闸门拦截弹窗，read 直通。
 */
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

/** StatusBar 组件属性。 */
export interface StatusBarProps {
  /** 模型名（缺省不显示该段；runTui 注入 provider.modelId）。 */
  readonly modelName?: string;
  /** 权限模式（缺省不显示该段；runTui 从工具注册表推导）。 */
  readonly permissionMode?: PermissionMode;
  /** 本会话累计 token（App 消费 usage 事件累加后传入）。 */
  readonly totals: TokenTotals;
  /** 运行状态：turn_start → true；turn_end / error → false。 */
  readonly running: boolean;
  /** 当前轮次（turn_start 事件携带；未开始过为 0）。 */
  readonly turn: number;
  /**
   * 计划模式（T-112 Plan Mode）：true = 只读研究阶段，状态栏显示「计划模式」段。
   * 缺省不显示该段。
   */
  readonly planMode?: boolean;
}

/**
 * 状态栏（T-045 最小版）。纯展示组件：所有状态由 App 层持有并传入，
 * 本组件不订阅事件流。缓存命中累计 > 0 时额外显示「cache +N」。
 */
export function StatusBar(props: StatusBarProps): ReactElement {
  const { modelName, permissionMode, totals, running, turn, planMode } = props;

  const segments: string[] = [];
  if (planMode === true) segments.push('计划模式');
  if (modelName !== undefined) segments.push(modelName);
  if (permissionMode !== undefined) {
    segments.push(PERMISSION_MODE_LABEL[permissionMode]);
  }
  segments.push(running ? '● 运行中' : '○ 就绪');
  segments.push(`turn ${turn}`);
  segments.push(`in ${totals.inputTokens} / out ${totals.outputTokens}`);
  if (totals.cacheReadTokens > 0) {
    segments.push(`cache +${totals.cacheReadTokens}`);
  }

  return (
    <Box>
      <Text dimColor>{segments.join(' · ')}</Text>
    </Box>
  );
}
