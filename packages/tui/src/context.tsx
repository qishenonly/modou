/**
 * /context 用量面板（T-063）：分项条（名称 / token / 占比）+ 合计 + budget drift。
 *
 * 数据来源是协议 `context_state` 负载（runTui 在用户敲 /context 时经
 * `buildContextState` 实时组装后注入 App prop）——本组件是纯展示，不订阅事件、
 * 不持有 core 内部对象（002 2.1：前端是 core 的纯消费者）。
 *
 * 渲染：
 * - 每个分项一行：中文标签 + token 数 + 占比条（固定宽度，按占比填充）+ 百分比；
 *   分项顺序用 core 导出的 CONTEXT_SECTION_NAMES（稳定前缀在前、易变区在后，
 *   002 7.1 分段），负载里缺失的分项按 0 显示——保证面板永远五行齐全；
 * - 底部合计行 + drift 行（粗估 vs 实测，偏差大说明字符级近似与供应商分词器
 *   的系统性偏离，002 7.3）+ 压缩临近标记（0.7.0 前恒「否」）。
 *
 * 关闭：由 App 层全局键处理（Esc → onContextDismiss），本组件不监听键盘。
 */
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { CONTEXT_SECTION_NAMES } from '@modou/core';
import type { ContextStateData } from '@modou/core';

/** 分项名称（协议机器可读标识）→ 中文标签（002 7.1 分段）。 */
export const CONTEXT_SECTION_LABELS: Readonly<Record<string, string>> = {
  system: '系统提示',
  tools: '工具定义',
  instructions: '项目指令',
  history: '历史消息',
  tool_output: '工具输出',
};

/** 占比条宽度（字符）。 */
export const CONTEXT_BAR_WIDTH = 20;

/** ContextPanel 组件属性。 */
export interface ContextPanelProps {
  /** 待展示的分项核算（context_state 负载）。 */
  readonly state: ContextStateData;
}

/**
 * 把分项核算格式化为人类可读的纯文本（一行一个分项）。
 * 独立导出：`/context --json` 走 JSON，普通 `/context` 走面板；两者共用
 * 本格式化器便于离线测试（不依赖 Ink 渲染）。
 */
export function formatContextRows(state: ContextStateData): string[] {
  const rows: string[] = [];
  for (const name of CONTEXT_SECTION_NAMES) {
    const section = state.sections.find((item) => item.name === name);
    const tokens = section?.tokens ?? 0;
    const ratio = state.total === 0 ? 0 : tokens / state.total;
    const filled = Math.round(ratio * CONTEXT_BAR_WIDTH);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(CONTEXT_BAR_WIDTH - filled)}`;
    const label = CONTEXT_SECTION_LABELS[name] ?? name;
    const percent = `${(ratio * 100).toFixed(1)}%`.padStart(6);
    rows.push(`${label}  ${String(tokens).padStart(6)}  ${bar}  ${percent}`);
  }
  return rows;
}

/** 合计 + drift + 压缩临近的尾部说明行。 */
export function formatContextFooter(state: ContextStateData): string {
  const drift = state.drift;
  const rate = `${(drift.rate * 100).toFixed(1)}%`;
  return (
    `合计 ${state.total} tokens · 粗估 ${drift.estimated} vs 实测 ${drift.actual}` +
    `（偏差 ${drift.error} / ${rate}）· 压缩临近：${state.nearCompaction ? '是' : '否'}`
  );
}

/** /context 用量面板（T-063）：纯展示，Esc 由 App 全局键关闭。 */
export function ContextPanel(props: ContextPanelProps): ReactElement {
  const { state } = props;
  return (
    <Box flexDirection="column">
      <Text color="cyan">/context 上下文用量</Text>
      {formatContextRows(state).map((row, index) => (
        <Text key={index}>{row}</Text>
      ))}
      <Text dimColor>{formatContextFooter(state)}</Text>
      <Text dimColor>（Esc 关闭）</Text>
    </Box>
  );
}
