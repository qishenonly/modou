/**
 * 快照选择器（T-102 /rewind）：列出快照点，选择后预览差异并确认还原。
 *
 * ## 分工
 *
 * - `SnapshotPicker`：选择器组件。消费 `SnapshotStore.listSnapshots()` 产出的
 *   快照点列表（新 → 旧），展示短哈希 / 时间 / 改动摘要；选中后 runTui 计算
 *   回滚预览（`previewRewind`），本组件进入确认态展示「将还原 N 个 / 删除 M 个 /
 *   覆盖 K 个（手动改动）」；确认后 runTui 执行 `rewindTo` 并插入会话说明。
 * - 打开期间 App 层隐藏输入行（阻塞输入提交），全局 Esc（interrupt）让给
 *   选择器——Esc 此时表示「取消 / 返回」，不再打断当前轮（与 /resume 惯例一致）。
 *
 * ## 键盘（选择器打开期间）
 *
 * - 列表态：数字键 `1..9` 直接选择；`↑`/`↓` 移动；`Enter` 确认选中 → 进入确认态；
 * - 确认态：`Enter` 执行还原；`Esc` 返回列表；
 * - 两种状态 `Esc` 均为「返回上一步 / 关闭」，不打断当前轮。
 */
import { useRef, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import type { RewindPreview, SnapshotPoint } from '@modou/core';

/** SnapshotPicker 组件属性。 */
export interface SnapshotPickerProps {
  /** 待选快照点列表（runTui 注入，新 → 旧；App 层保证非空才渲染本组件）。 */
  readonly candidates: readonly SnapshotPoint[];
  /**
   * 回滚预览：非空 = 确认态（用户已选一个快照点，展示差异等待确认）。
   * undefined = 列表态。
   */
  readonly preview?: RewindPreview;
  /** 用户选中一个快照点（id；runTui 计算预览）。 */
  readonly onSelect: (id: string) => void;
  /** 用户确认还原（runTui 执行 rewindTo 并插入会话说明）。 */
  readonly onConfirm: () => void;
  /** 用户取消 / 返回（runTui 关选择器或退回列表态）。 */
  readonly onCancel: () => void;
}

/** epoch ms → `YYYY-MM-DD HH:mm`（本地时区；ts<=0 时显示占位）。 */
function formatTime(ts: number): string {
  if (ts <= 0) return '?';
  const date = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 完整哈希 → 8 位短哈希（展示用；degraded 点为占位）。 */
function shortId(id: string | null): string {
  if (id === null || id.length <= 8) return id ?? '—';
  return id.slice(0, 8);
}

/** 改动摘要截断到单行可读长度（列表展示用）。 */
function shortSummary(summary: string, max = 36): string {
  const collapsed = summary.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * 快照选择器（T-102）。App 层在候选非空时渲染本组件，选中项初值恒为 0。
 * 键盘回调用 ref 镜像最新候选 / 选中项 / 预览（与 input.tsx / resume.tsx 同惯例）。
 */
export function SnapshotPicker({
  candidates,
  preview,
  onSelect,
  onConfirm,
  onCancel,
}: SnapshotPickerProps): ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const selectedRef = useRef(selectedIndex);
  selectedRef.current = selectedIndex;
  // 确认态：预览存在时忽略方向键 / 数字键，只响应 Enter（确认）与 Esc（返回）
  const previewRef = useRef(preview);
  previewRef.current = preview;

  const confirmSelect = (): void => {
    const candidate = candidatesRef.current[selectedRef.current];
    if (candidate !== undefined && candidate.id !== null) {
      onSelect(candidate.id);
    }
  };

  useInput((input, key) => {
    // 确认态：Enter 确认还原；Esc 返回列表
    if (previewRef.current !== undefined) {
      if (key.return || input === '\r') {
        onConfirm();
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      return; // 确认态忽略其余键
    }

    // 列表态：数字键直接选择
    if (input.length === 1 && input >= '1' && input <= '9') {
      const index = input.charCodeAt(0) - 49;
      const candidate = candidatesRef.current[index];
      if (candidate !== undefined && candidate.id !== null)
        onSelect(candidate.id);
      return;
    }

    // Enter：进入确认态（onSelect → runTui 计算预览）
    if (key.return || input === '\r') {
      confirmSelect();
      return;
    }

    // ↑ / ↓：循环移动选中项
    if (key.upArrow || key.downArrow) {
      const count = candidatesRef.current.length;
      if (count > 0) {
        setSelectedIndex((prev) =>
          key.upArrow ? (prev - 1 + count) % count : (prev + 1) % count,
        );
      }
      return;
    }

    // Esc：取消（关闭选择器）。App 层的全局 Esc 在选择器打开时让路（见 app.tsx）。
    if (key.escape) {
      onCancel();
      return;
    }
  });

  // 确认态：展示差异 + 覆盖警告，等待回车
  if (preview !== undefined) {
    const target = candidates.find(
      (candidate) => candidate.id === preview.snapshotId,
    );
    const title =
      target !== undefined ? shortId(target.id) : shortId(preview.snapshotId);
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="yellow"
        marginTop={1}
        paddingX={1}
      >
        <Text bold color="yellow">
          还原到快照 {title}（
          {target !== undefined ? formatTime(target.ts) : '?'}）
        </Text>
        <Text>
          将还原 {preview.restoreFiles.length} 个文件
          {preview.deleteFiles.length > 0
            ? `，删除 ${preview.deleteFiles.length} 个文件`
            : ''}
        </Text>
        {preview.overwriteFiles.length > 0 && (
          <Text color="red">
            警告：{preview.overwriteFiles.length}{' '}
            个文件当前与快照不同（含手动改动）， 还原将覆盖这些改动：
            {preview.overwriteFiles.slice(0, 3).join('、')}
            {preview.overwriteFiles.length > 3 ? ' 等' : ''}
          </Text>
        )}
        <Text dimColor>Enter 确认还原 · Esc 返回</Text>
      </Box>
    );
  }

  // 列表态：展示快照点（短哈希 / 时间 / 摘要 / 文件数）
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      marginTop={1}
      paddingX={1}
    >
      <Text bold color="cyan">
        快照点（/rewind）
      </Text>
      <Box flexDirection="column">
        {candidates.map((candidate, index) => (
          <Text
            key={candidate.id ?? `degraded-${candidate.ts}`}
            inverse={index === selectedIndex}
            dimColor={index !== selectedIndex}
          >
            {index + 1}) {shortId(candidate.id)} · {formatTime(candidate.ts)} ·{' '}
            {shortSummary(candidate.summary)}
            {candidate.degraded ? ' · [降级]' : ''}
          </Text>
        ))}
      </Box>
      <Text dimColor>数字键或 ↑/↓ + Enter 选择 · Esc 取消</Text>
    </Box>
  );
}
