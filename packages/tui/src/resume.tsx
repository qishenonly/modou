/**
 * 会话选择器（T-061 /resume）：展示可恢复会话列表，供用户选择或取消。
 *
 * ## 分工
 *
 * - `ResumePicker`：选择器组件。消费 `listSessionsForResume` 产出的候选列表
 *   （core 已按时间倒序 + 附简要开头），展示会话 ID / 末条时间 / 记录条数 /
 *   简要开头；键盘选择后经 `onSelect(sessionId)` 回调，App 层把它交给 runTui
 *   恢复并继续对话。
 * - 打开期间 App 层隐藏输入行（阻塞输入提交），全局 Esc（interrupt）让给
 *   选择器——Esc 此时表示「取消」，不再打断当前轮（与审批弹窗同一惯例）。
 *
 * ## 键盘（选择器打开期间）
 *
 * - 数字键 `1..9`：直接选择对应会话（1-based，越界忽略）；
 * - `↑` / `↓`：循环移动选中项；`Enter`：选择当前选中项；
 * - `Esc`：取消（关闭选择器，回到正常输入）。
 */
import { useRef, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ResumeCandidate } from '@modou/core';

/** ResumePicker 组件属性。 */
export interface ResumePickerProps {
  /** 待选会话列表（core 已按时间倒序排列；App 层保证非空才渲染本组件）。 */
  readonly candidates: readonly ResumeCandidate[];
  /** 用户选中一个会话（sessionId；runTui 负责恢复并继续）。 */
  readonly onSelect: (sessionId: string) => void;
  /** 用户取消选择（Esc；runTui 关闭选择器）。 */
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

/**
 * 会话选择器（T-061）。App 层在候选非空时渲染本组件，因此选中项初值恒为 0，
 * 无需在候选变化时手动复位。键盘回调用 ref 镜像最新候选与选中项（与
 * input.tsx / approval.tsx 同一惯例，保证同 tick 突发按键看到最新值）。
 */
export function ResumePicker({
  candidates,
  onSelect,
  onCancel,
}: ResumePickerProps): ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const selectedRef = useRef(selectedIndex);
  selectedRef.current = selectedIndex;

  const confirm = (): void => {
    const candidate = candidatesRef.current[selectedRef.current];
    if (candidate !== undefined) onSelect(candidate.sessionId);
  };

  useInput((input, key) => {
    // 数字键 1..9：直接选择对应会话（编号 1-based，越界忽略）
    if (input.length === 1 && input >= '1' && input <= '9') {
      const index = input.charCodeAt(0) - 49;
      const candidate = candidatesRef.current[index];
      if (candidate !== undefined) onSelect(candidate.sessionId);
      return;
    }

    // Enter：选择当前选中项（实测 `\r` → key.return=true，同 input.tsx）
    if (key.return || input === '\r') {
      confirm();
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

    // Esc：取消。App 层的全局 Esc（interrupt）在选择器打开时让路（见 app.tsx），
    // 此处不会与打断命令冲突。
    if (key.escape) {
      onCancel();
      return;
    }

    // 其余键忽略：选择器期间输入提交被阻塞，Ctrl+C 由 App 层退出
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      marginTop={1}
      paddingX={1}
    >
      <Text bold color="cyan">
        已保存的会话（/resume）
      </Text>
      <Box flexDirection="column">
        {candidates.map((candidate, index) => (
          <Text
            key={candidate.sessionId}
            inverse={index === selectedIndex}
            dimColor={index !== selectedIndex}
          >
            {index + 1}) {candidate.sessionId} · {formatTime(candidate.lastTs)}{' '}
            · {candidate.entryCount} 条
            {candidate.preview.length > 0 ? ` · ${candidate.preview}` : ''}
          </Text>
        ))}
      </Box>
      <Text dimColor>数字键或 ↑/↓ + Enter 选择 · Esc 取消</Text>
    </Box>
  );
}
