/**
 * 审批弹窗（T-044）：展示待执行操作详情（命令全文/diff），三选项裁决
 * （allow_once / allow_always / deny），裁决经 `approve` Command 回传 core。
 *
 * ## 分工
 *
 * - `ApprovalModal`：弹窗组件。消费 `approval_request` 数据，展示操作描述、
 *   风险级别与可选项；键盘裁决后经 `onApprove(requestId, decision)` 回调，
 *   App 层把它转成 `approve` Command（002 3.3 表）发回 core；
 * - `createApprovalBridge`：runTui 装配侧的「审批桥」——把 TUI 的 `approve`
 *   Command 接到 core `ApprovalGate` 的 decider 上（用户选择 → resolve），
 *   默认 deny（无人裁决时一律拒绝，与 headless 同款安全默认）。
 *
 * 危险命令（rm -rf 等黑名单）由 core 侧强制逐次确认（T-033），选项不含
 * `allow_always`；TUI 只透传 core 给的可选项，不在前端补全。
 *
 * ## 键盘（弹窗打开期间）
 *
 * - 数字键 `1..9`：直接裁决对应选项（选项按 core 给的可选项顺序编号，1-based）；
 * - `↑` / `↓`：循环移动选中项；`Enter`：裁决当前选中项；
 * - `Esc`：拒绝（弹窗语义 = 取消当前操作）。
 *
 * 弹窗打开时 App 层隐藏输入框（阻塞输入提交），并把全局 Esc（interrupt）
 * 让给弹窗——Esc 此时表示「拒绝」，不再打断当前轮。
 */
import { useRef, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
  ApprovalDecision,
  ApprovalRequestData,
  ApprovalResolvedData,
  ApprovalVerdict,
  PendingApprovalRequest,
  RiskLevel,
} from '@modou/core';
import { ApprovalGate } from '@modou/core';

/** 风险级别的中文标签（弹窗展示；与 002 5.2 的 risk 分类一一对应）。 */
const RISK_LABEL: Readonly<Record<RiskLevel, string>> = {
  read: '读取',
  write: '写入',
  exec: '执行',
  network: '网络',
};

// ---------------------------------------------------------------------------
// ApprovalModal：审批弹窗组件
// ---------------------------------------------------------------------------

/** ApprovalModal 组件属性。 */
export interface ApprovalModalProps {
  /** 待裁决的审批请求（App 层保证非空时才渲染本组件）。 */
  readonly request: ApprovalRequestData;
  /** 用户裁决回调：App 层把它转成 `approve` Command（带 requestId + decision）。 */
  readonly onApprove: (requestId: string, decision: ApprovalDecision) => void;
}

/**
 * 审批弹窗（T-044）。App 层以 `key={request.id}` 渲染本组件，请求切换即
 * 整体重挂载，因此选中项初值永远从 0 起，无需在请求变化时手动复位。
 */
export function ApprovalModal({
  request,
  onApprove,
}: ApprovalModalProps): ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 键盘回调每次渲染重绑，读到的可能是旧闭包：用 ref 保存最新请求与选中项
  // （与 input.tsx / tools.tsx 同一惯例，保证同 tick 突发按键看到最新值）。
  const requestRef = useRef(request);
  requestRef.current = request;
  const selectedRef = useRef(selectedIndex);
  selectedRef.current = selectedIndex;

  const confirm = (decision: ApprovalDecision): void => {
    onApprove(requestRef.current.id, decision);
  };

  useInput((input, key) => {
    // 数字键 1..9：直接裁决对应选项（选项编号 1-based，越界忽略）
    if (input.length === 1 && input >= '1' && input <= '9') {
      const index = input.charCodeAt(0) - 49;
      const options = requestRef.current.options;
      if (index < options.length) confirm(options[index].id);
      return;
    }

    // Enter：裁决当前选中项（实测 `\r` → key.return=true，同 input.tsx）
    if (key.return || input === '\r') {
      const option = requestRef.current.options[selectedRef.current];
      if (option !== undefined) confirm(option.id);
      return;
    }

    // ↑ / ↓：循环移动选中项
    if (key.upArrow || key.downArrow) {
      const count = requestRef.current.options.length;
      setSelectedIndex((prev) =>
        key.upArrow ? (prev - 1 + count) % count : (prev + 1) % count,
      );
      return;
    }

    // Esc：拒绝（弹窗语义 = 取消当前操作）。App 层的全局 Esc（interrupt）
    // 在弹窗打开时让路（见 app.tsx），此处不会与打断命令冲突。
    if (key.escape) {
      confirm('deny');
      return;
    }

    // 其余键（含 Ctrl 组合）忽略：弹窗期间输入提交被阻塞，Ctrl+C 由 App 层退出
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      marginTop={1}
      paddingX={1}
    >
      <Text bold color="yellow">
        ⚠ 审批请求
      </Text>
      <Box>
        <Text dimColor>
          风险：{RISK_LABEL[request.risk] ?? request.risk} · 操作：
        </Text>
        <Text>{request.description}</Text>
      </Box>
      <Box flexDirection="column">
        {request.options.map((option, index) => (
          <Text
            key={option.id}
            inverse={index === selectedIndex}
            dimColor={index !== selectedIndex}
          >
            {index + 1}) {option.label}
          </Text>
        ))}
      </Box>
      <Text dimColor>数字键或 ↑/↓ + Enter 裁决 · Esc 拒绝</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// createApprovalBridge：runTui 侧的审批裁决桥
// ---------------------------------------------------------------------------

/** 审批桥：把 TUI 的 `approve` Command 接到 ApprovalGate 的 decider 上。 */
export interface ApprovalBridge {
  /** 注入 `runAgentTurn` 的审批闸门（decider = 等用户从弹窗裁决）。 */
  readonly gate: ApprovalGate;
  /**
   * 用户裁决：App 的 `approve` Command 到达时调用，resolve 对应 pending 请求。
   * 返回是否命中（false = 该 requestId 已裁决 / 不存在，调用方忽略即可）。
   */
  resolve(requestId: string, decision: ApprovalDecision): boolean;
  /**
   * 收尾：把尚未裁决的请求一律按拒绝 resolve（source 默认 policy）。
   * 退出 TUI 时调用，防止 pending 审批悬挂导致轮次永不结束。
   */
  denyAll(source?: ApprovalResolvedData['source']): void;
}

/**
 * 创建审批桥。decider 对每个请求返回一个挂起的 Promise，等弹窗裁决后经
 * `resolve` 落地（source 记 user）；`denyAll` 供退出收尾时清空未裁决请求。
 *
 * 注意：未注入 decider 时 ApprovalGate 缺省一律拒绝（deny，source: policy），
 * 这里显式注入 decider 使裁决权交给 TUI 弹窗——与 headless 的 `approve`
 * 回调等价（headless 的 buildApprovalGate 见 cli/src/headless.ts）。
 */
export function createApprovalBridge(): ApprovalBridge {
  const pending = new Map<string, (verdict: ApprovalVerdict) => void>();
  let closed = false;

  const gate = new ApprovalGate({
    decider: (request: PendingApprovalRequest) =>
      new Promise<ApprovalVerdict>((resolve) => {
        // 退出（denyAll）后新到达的请求：立即按拒绝 resolve（fail-closed），
        // 不注册 pending——否则同轮后续审批在 TUI 已卸载后无人能裁决而悬挂
        if (closed) {
          resolve({ decision: 'deny', source: 'policy' });
          return;
        }
        // Promise executor 同步执行：requestApproval 调用后、await 前，
        // 本条 pending 已登记，可被后续 arrive 的 approve Command 命中。
        pending.set(request.id, resolve);
      }),
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
