import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequestData, Command, Envelope } from '@modou/core';
import { ApprovalModal } from './approval';
import { Input } from './input';
import { DEFAULT_FRAME_MS, Markdown, useFrameThrottledText } from './markdown';
import {
  StatusBar,
  ZERO_TOKEN_TOTALS,
  applyUsage,
  type PermissionMode,
  type TokenTotals,
} from './status';
import type { ToolCallEntry } from './tools';
import { reduceToolEvent, ToolCallList } from './tools';

/** App 组件属性（T-040 骨架 + T-041 输入框）。 */
export interface AppProps {
  /**
   * core 事件流：runAgentTurnStreaming 产出的信封序列（经 stream.ts 适配为
   * AsyncIterable）。App 是事件流的**纯消费者**——只读信封，不持有 core 内部对象。
   */
  readonly stream: AsyncIterable<Envelope>;
  /**
   * 发 Command 通道（002 3.3 反向通道）：App 的一切操作都转成 Command 经此回调
   * 回传 core。输入框（input.tsx）的提交 / 斜杠命令都汇聚到这里。
   */
  readonly send: (command: Command) => void;
  /** 干净退出回调（Ctrl+C 触发；由装配方 runTui 负责卸载与收尾）。 */
  readonly onExit?: () => void;
  /**
   * 模型名（T-045 状态栏：runTui 注入 provider.modelId）。
   * 缺省不显示该段——App 独立渲染（测试）时状态栏仍可用。
   */
  readonly modelName?: string;
  /**
   * 权限模式（T-045 状态栏：runTui 从工具注册表推导）。
   * 缺省不显示该段；0.4.0 只有「只读」/「写/执行需审批」两种。
   */
  readonly permissionMode?: PermissionMode;
}

/**
 * App：Ink 主应用（T-040 骨架）。
 *
 * 结构对齐 002 第十二节目录布局：
 * - 消息/输出区（markdown.tsx 流式渲染：语法高亮 + 帧节流，T-042）；
 * - 底部输入行（input.tsx：多行/粘贴/历史上翻/斜杠补全，T-041）；
 * - 状态栏（status.tsx，T-045：模型名 / 权限模式 / 累计 token / 运行状态）；
 * - tools.tsx / approval.tsx 分别由 T-043 / T-044 接入工具展示与审批弹窗。
 *
 * 键盘（T-041 分工）：
 * - App 层只管「全局键」：Esc 发 interrupt Command 打断当前轮、Ctrl+C 触发 onExit
 *   干净退出（headless 无键盘路径，不受影响）；审批弹窗打开时 Esc 让给弹窗
 *   （拒绝），Ctrl+C 仍可退出（T-044）；
 * - 输入编辑（字符/换行/光标移动/历史上翻/斜杠补全）全部由 input.tsx 处理；
 * - 输入框提交：普通文本 → submit，以 `/` 开头 → slash（002 3.3 表）；
 * - 审批弹窗（approval.tsx）：数字键 / ↑↓+Enter / Esc 裁决，期间输入行隐藏。
 *
 * 消费模型：事件流经 for-await 逐条应用（useEffect 内），卸载时置 disposed 停止。
 * 状态更新用函数式 setState，事件按 seq 到达即天然有序。
 */
export function App(props: AppProps): ReactElement {
  const { stream, send, onExit, modelName, permissionMode } = props;

  // 输出区：流式文本累计 + 帧节流（T-042 换 markdown 渲染，50ms 合并一次提交）
  const {
    text: assistantText,
    append: appendDelta,
    flush: flushDelta,
  } = useFrameThrottledText(DEFAULT_FRAME_MS);
  // 运行状态：由 turn_start / turn_end 推导（T-045 状态栏消费）
  const [running, setRunning] = useState(false);
  const [lastTurn, setLastTurn] = useState(0);
  // 本会话累计 token（T-045 状态栏消费：usage 事件逐次累加 input/output，
  // 最小版只累计不核算；完整 /context 分项在 0.6.0）
  const [totals, setTotals] = useState<TokenTotals>(ZERO_TOKEN_TOTALS);
  // 提示信息（配置告警、未知工具回馈等 notice 事件）
  const [notices, setNotices] = useState<string[]>([]);
  // 错误（002 5.3：错误即数据）
  const [error, setError] = useState<string | null>(null);
  // 工具调用条目（T-043：按 callId 组织 tool_call / tool_progress / tool_result，
  // 由 tools.tsx 的纯函数规约；跨轮次累计展示，与输出区文本同生命周期）
  const [tools, setTools] = useState<ToolCallEntry[]>([]);
  // 审批弹窗（T-044）：approval_request 打开 / approval_resolved 关闭。
  // 弹窗打开期间输入行被隐藏（阻塞输入提交），全局 Esc 让给弹窗（拒绝）。
  const [pendingApproval, setPendingApproval] =
    useState<ApprovalRequestData | null>(null);
  // 键盘回调读到的是旧闭包：用 ref 镜像弹窗是否打开，供 App 层全局键判断
  const approvalOpenRef = useRef(false);
  approvalOpenRef.current = pendingApproval !== null;

  // 输入行：T-041 起由 input.tsx 组件承载（多行编辑/粘贴/历史/斜杠补全），
  // App 不持有输入文本，只把提交的 Command 经 send 回传 core。

  // 消费 core 事件流
  useEffect(() => {
    let disposed = false;

    const apply = (envelope: Envelope): void => {
      switch (envelope.type) {
        case 'turn_start':
          // 防御：前一轮若有残留缓冲立即落盘（正常情况 turn_end 已 flush）
          flushDelta();
          setRunning(true);
          setLastTurn(envelope.data.turn);
          break;
        case 'text_delta':
          // 帧节流：只累积不渲染，frameMs 后合并提交一次 setState
          appendDelta(envelope.data.delta);
          break;
        case 'turn_end':
          // 帧尾立即提交，保证最终文本完整可见
          flushDelta();
          setRunning(false);
          break;
        case 'usage':
          // T-045 状态栏：累进会话总量（函数式 setState 防丢事件；缺省字段按 0 计）
          setTotals((prev) => applyUsage(prev, envelope.data));
          break;
        case 'notice':
          setNotices((prev) => [...prev, envelope.data.text]);
          break;
        case 'error':
          flushDelta();
          setRunning(false);
          setError(envelope.data.message);
          break;
        case 'tool_call':
        case 'tool_progress':
        case 'tool_result':
          // T-043 工具调用展示：三个工具事件统一进规约函数，按 callId 组织条目
          setTools((prev) => reduceToolEvent(prev, envelope));
          break;
        case 'approval_request':
          // T-044 审批弹窗：core ③ Authorize 发来请求 → 打开弹窗等用户裁决
          setPendingApproval(envelope.data);
          break;
        case 'approval_resolved':
          // 裁决收尾（用户 / 规则 / 策略）：关闭对应弹窗（id 不匹配则忽略，
          // 防御迟到的旧请求收尾事件误关当前弹窗）
          setPendingApproval((prev) =>
            prev !== null && prev.id === envelope.data.id ? null : prev,
          );
          break;
        default:
          // thinking_delta / context_state / compaction 由后续任务处理。
          break;
      }
    };

    void (async () => {
      for await (const envelope of stream) {
        if (disposed) break;
        apply(envelope);
      }
    })();

    return () => {
      disposed = true;
    };
  }, [stream]);

  // 键盘处理：App 层只管「全局键」——Esc 打断、Ctrl+C 干净退出。
  // 输入编辑（字符/换行/光标/历史/补全）全部由 input.tsx 的 useInput 处理。
  // 弹窗打开时：Esc 让给弹窗（拒绝），App 不再发 interrupt；Ctrl+C 仍可退出
  // （runTui 收尾会以 deny 清空未裁决的审批请求，不会悬挂轮次）。
  useInput((_text, key) => {
    if (approvalOpenRef.current) {
      if (key.ctrl && _text === 'c') {
        onExit?.();
      }
      return;
    }
    if (key.escape) {
      send({ type: 'interrupt' });
      return;
    }
    if (key.ctrl && _text === 'c') {
      onExit?.();
      return;
    }
  });

  // 输入框 → Command 通道（002 3.3 表：submit 普通文本 / slash 斜杠命令）
  const handleSubmit = (text: string): void => {
    send({ type: 'submit', text });
  };
  const handleSlash = (name: string, args?: string): void => {
    send(
      args === undefined
        ? { type: 'slash', name }
        : { type: 'slash', name, args },
    );
  };

  return (
    <Box flexDirection="column" minHeight={5}>
      {/* 消息/输出区（markdown.tsx 渲染 + 帧节流，T-042） */}
      <Box flexGrow={1} flexDirection="column">
        {/* 工具调用展示（T-043）：工具区在上、输出区在下；折叠/展开 + diff 高亮 */}
        {tools.length > 0 && <ToolCallList entries={tools} />}
        {assistantText.length > 0 && <Markdown text={assistantText} />}
        {notices.map((notice, index) => (
          <Text key={index} color="yellow">
            {notice}
          </Text>
        ))}
        {error !== null && <Text color="red">错误：{error}</Text>}
      </Box>

      {/* 状态栏（status.tsx，T-045）：模型名 / 权限模式 / 累计 token / 运行状态 */}
      <StatusBar
        modelName={modelName}
        permissionMode={permissionMode}
        totals={totals}
        running={running}
        turn={lastTurn}
      />

      {/* 审批弹窗（T-044）：approval_request 打开，approval_resolved 关闭；
          弹窗期间输入行隐藏（阻塞输入提交），裁决后恢复 */}
      {pendingApproval !== null && (
        <ApprovalModal
          key={pendingApproval.id}
          request={pendingApproval}
          onApprove={(requestId, decision) =>
            send({ type: 'approve', requestId, decision })
          }
        />
      )}

      {/* 底部输入行（input.tsx：多行 / 粘贴 / 历史上翻 / 斜杠补全）。
          审批弹窗打开时隐藏——模态期间不接受新的输入提交 */}
      {pendingApproval === null && (
        <Box>
          <Text color="cyan">&gt; </Text>
          <Box flexGrow={1}>
            <Input onSubmit={handleSubmit} onSlash={handleSlash} />
          </Box>
        </Box>
      )}
    </Box>
  );
}
