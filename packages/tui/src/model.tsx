/**
 * 模型选择器（T-082 /model）：展示候选模型列表，供用户选择或取消。
 *
 * ## 分工
 *
 * - `ModelPicker`：选择器组件。消费 `collectModelCandidates`（slash.ts）产出的
 *   候选模型 ID 列表（当前模型 → 环境变量派生的模型 → 已知缺省锚点），展示
 *   候选并标注当前模型；键盘选择后经 `onSelect(modelId)` 回调，App 层把它交给
 *   runTui 重建 provider（002 8.2「/model 换 provider 实例」）。
 * - 打开期间 App 层隐藏输入行（阻塞输入提交），全局 Esc（interrupt）让给
 *   选择器——Esc 此时表示「取消」，不再打断当前轮（与 /resume 选择器同一惯例）。
 *
 * ## 键盘（选择器打开期间）
 *
 * - 数字键 `1..9`：直接选择对应候选（1-based，越界忽略）；
 * - `↑` / `↓`：循环移动选中项；`Enter`：选择当前选中项；
 * - `Esc`：取消（关闭选择器，回到正常输入）。
 */
import { useRef, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';

/** ModelPicker 组件属性。 */
export interface ModelPickerProps {
  /** 候选模型 ID 列表（slash.ts 的 collectModelCandidates 产出；App 层保证非空）。 */
  readonly candidates: readonly string[];
  /** 当前模型 ID（列表里高亮标注）。 */
  readonly currentModel: string;
  /** 用户选中一个模型（modelId；runTui 负责重建 provider 并续写同一会话）。 */
  readonly onSelect: (modelId: string) => void;
  /** 用户取消选择（Esc；runTui 关闭选择器）。 */
  readonly onCancel: () => void;
}

/**
 * 模型选择器（T-082）。App 层在候选非空时渲染本组件，因此选中项初值恒为 0，
 * 无需在候选变化时手动复位。键盘回调用 ref 镜像最新候选与选中项（与
 * input.tsx / approval.tsx / resume.tsx 同一惯例，保证同 tick 突发按键看到
 * 最新值）。
 */
export function ModelPicker({
  candidates,
  currentModel,
  onSelect,
  onCancel,
}: ModelPickerProps): ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const selectedRef = useRef(selectedIndex);
  selectedRef.current = selectedIndex;

  const confirm = (): void => {
    const candidate = candidatesRef.current[selectedRef.current];
    if (candidate !== undefined) onSelect(candidate);
  };

  useInput((input, key) => {
    // 数字键 1..9：直接选择对应候选（编号 1-based，越界忽略）
    if (input.length === 1 && input >= '1' && input <= '9') {
      const index = input.charCodeAt(0) - 49;
      const candidate = candidatesRef.current[index];
      if (candidate !== undefined) onSelect(candidate);
      return;
    }

    // Enter：选择当前选中项（实测 `\r` → key.return=true，同 resume.tsx）
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
        切换模型（/model）
      </Text>
      <Box flexDirection="column">
        {candidates.map((candidate, index) => (
          <Text
            key={candidate}
            inverse={index === selectedIndex}
            dimColor={index !== selectedIndex}
          >
            {index + 1}) {candidate}
            {candidate === currentModel ? '  ← 当前' : ''}
          </Text>
        ))}
      </Box>
      <Text dimColor>数字键或 ↑/↓ + Enter 选择 · Esc 取消</Text>
    </Box>
  );
}
