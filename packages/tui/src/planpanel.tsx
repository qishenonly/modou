/**
 * 计划面板（T-112 Plan Mode）：展示模型产出的结构化计划，等待用户批准 / 修改 /
 * 拒绝。
 *
 * 数据是 core `StructuredPlan`（五段固定结构：目标 / 涉及文件 / 分步改动 / 验证
 * 方式 / 风险点，ADR 0010）——runTui 在模型轮次结束后解析产出并注入 App prop。
 * 本组件是纯展示 + 键盘裁决，不订阅事件、不持有 core 内部对象。
 *
 * ## 键盘（面板打开期间）
 *
 * - `a` / `A`：批准（切回执行模式并按计划执行）；
 * - `r` / `R` 或 `Esc`：拒绝（切回执行模式，零文件改动——Plan Mode 只读）；
 * - `e` / `E`：修改（关闭面板，保留计划模式，把计划回显为文本供用户编辑）。
 *
 * 面板打开时 App 层隐藏输入行（阻塞输入提交），并把全局 Esc（interrupt）让给
 * 面板——Esc 此时表示「拒绝」，不打断任何轮次（计划轮已结束）。
 */
import { useRef, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  PLAN_SECTION_KEYS,
  PLAN_SECTION_TITLES,
  type StructuredPlan,
} from '@modou/core';

/** PlanPanel 组件属性。 */
export interface PlanPanelProps {
  /** 待评审的结构化计划（runTui 解析模型输出所得）。 */
  readonly plan: StructuredPlan;
  /** 批准：runTui 切回执行模式并按计划开始执行。 */
  readonly onApprove: () => void;
  /** 拒绝：runTui 切回执行模式并告知零改动。 */
  readonly onReject: () => void;
  /** 修改：runTui 关闭面板、保留计划模式、回显计划文本供用户编辑。 */
  readonly onEdit: () => void;
}

/** 把结构化计划格式化为纯文本行（独立导出便于测试；App notice 复用）。 */
export function formatPlanLines(plan: StructuredPlan): string[] {
  const lines: string[] = ['# 实施计划'];
  for (const key of PLAN_SECTION_KEYS) {
    lines.push('', `## ${PLAN_SECTION_TITLES[key]}`);
    if (key === 'goal') {
      // goal 是单条文本（不是数组），整行输出
      lines.push(plan.goal.length > 0 ? plan.goal : '（无）');
      continue;
    }
    const items = plan[key] as readonly string[];
    if (items.length === 0) {
      lines.push('（无）');
    } else {
      for (const item of items) lines.push(`- ${item}`);
    }
  }
  return lines;
}

/** 计划面板（T-112）。App 层在 planProposal 非空时渲染；裁决经回调回传 runTui。 */
export function PlanPanel({
  plan,
  onApprove,
  onReject,
  onEdit,
}: PlanPanelProps): ReactElement {
  // 键盘回调每次渲染重绑：用 ref 保存最新回调（同 tick 突发按键看到最新值）
  const approveRef = useRef(onApprove);
  approveRef.current = onApprove;
  const rejectRef = useRef(onReject);
  rejectRef.current = onReject;
  const editRef = useRef(onEdit);
  editRef.current = onEdit;

  useInput((input, key) => {
    if (input === 'a' || input === 'A') {
      approveRef.current();
      return;
    }
    if (input === 'r' || input === 'R' || key.escape) {
      rejectRef.current();
      return;
    }
    if (input === 'e' || input === 'E') {
      editRef.current();
      return;
    }
    // 其余键忽略（Ctrl+C 由 App 层退出）
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      marginTop={1}
      paddingX={1}
    >
      <Text bold color="magenta">
        计划提案（Plan Mode）
      </Text>
      {formatPlanLines(plan).map((line, index) =>
        line.startsWith('## ') ? (
          <Text key={index} bold color="cyan">
            {line}
          </Text>
        ) : (
          <Text key={index}>{line}</Text>
        ),
      )}
      <Text dimColor>a 批准 · e 修改 · r/Esc 拒绝（拒绝 = 零文件改动）</Text>
    </Box>
  );
}
