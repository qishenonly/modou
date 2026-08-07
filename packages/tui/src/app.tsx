import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Command, Envelope, UsageData } from '@modou/core';

/** App 组件属性（T-040 骨架）。 */
export interface AppProps {
  /**
   * core 事件流：runAgentTurnStreaming 产出的信封序列（经 stream.ts 适配为
   * AsyncIterable）。App 是事件流的**纯消费者**——只读信封，不持有 core 内部对象。
   */
  readonly stream: AsyncIterable<Envelope>;
  /**
   * 发 Command 通道（002 3.3 反向通道）：App 的一切操作都转成 Command 经此回调
   * 回传 core。本版是简单回调（T-041 输入框会把它接到更完整的状态）。
   */
  readonly send: (command: Command) => void;
  /** 干净退出回调（Ctrl+C 触发；由装配方 runTui 负责卸载与收尾）。 */
  readonly onExit?: () => void;
}

/**
 * App：Ink 主应用（T-040 骨架）。
 *
 * 结构对齐 002 第十二节目录布局：
 * - 消息/输出区（本版流式纯文本；T-042 换成 markdown.tsx 并做帧节流）；
 * - 底部输入行（本版最小单行输入，T-041 换成 input.tsx：多行/粘贴/历史上翻/斜杠）；
 * - 状态栏位（本版内联一行占位，T-045 换成 status.tsx：模型名/token/权限模式）；
 * - tools.tsx / approval.tsx 分别由 T-043 / T-044 接入工具展示与审批弹窗。
 *
 * 键盘（T-040 范围）：
 * - 回车：提交输入行（空输入不提交）；
 * - Esc：发 interrupt Command 打断当前轮（headless 无键盘路径，不受影响）；
 * - Ctrl+C：触发 onExit 干净退出（交互式 TUI 里 Ctrl+C 是主动退出，非信号中断）。
 *
 * 消费模型：事件流经 for-await 逐条应用（useEffect 内），卸载时置 disposed 停止。
 * 状态更新用函数式 setState，事件按 seq 到达即天然有序。
 */
export function App(props: AppProps): ReactElement {
  const { stream, send, onExit } = props;

  // 输出区：流式文本累计（T-042 换 markdown 渲染 + 帧节流）
  const [assistantText, setAssistantText] = useState('');
  // 运行状态：由 turn_start / turn_end 推导（T-045 状态栏完善）
  const [running, setRunning] = useState(false);
  const [lastTurn, setLastTurn] = useState(0);
  // 最近一次 usage（T-045 状态栏消费；minimal 版只报 token）
  const [usage, setUsage] = useState<UsageData | null>(null);
  // 提示信息（配置告警、未知工具回馈等 notice 事件）
  const [notices, setNotices] = useState<string[]>([]);
  // 错误（002 5.3：错误即数据）
  const [error, setError] = useState<string | null>(null);

  // 输入行内容：state 供渲染，ref 供键盘回调读最新值
  // （useInput 的 handler 每次渲染都重建，用 ref 绕开闭包过期的可能）
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef('');

  // 消费 core 事件流
  useEffect(() => {
    let disposed = false;

    const apply = (envelope: Envelope): void => {
      switch (envelope.type) {
        case 'turn_start':
          setRunning(true);
          setLastTurn(envelope.data.turn);
          break;
        case 'text_delta':
          setAssistantText((prev) => prev + envelope.data.delta);
          break;
        case 'turn_end':
          setRunning(false);
          break;
        case 'usage':
          setUsage(envelope.data);
          break;
        case 'notice':
          setNotices((prev) => [...prev, envelope.data.text]);
          break;
        case 'error':
          setRunning(false);
          setError(envelope.data.message);
          break;
        default:
          // thinking_delta / tool_call / tool_progress / tool_result /
          // approval_request / approval_resolved / context_state / compaction
          // 由 T-042（markdown 折叠）/ T-043（tools.tsx）/ T-044（approval.tsx）
          // 后续处理；T-040 骨架先忽略。
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

  // 键盘处理
  useInput((text, key) => {
    if (key.return) {
      const value = inputRef.current.trim();
      if (value.length > 0) {
        send({ type: 'submit', text: value });
        inputRef.current = '';
        setInputValue('');
      }
      return;
    }
    if (key.escape) {
      send({ type: 'interrupt' });
      return;
    }
    if (key.ctrl && text === 'c') {
      onExit?.();
      return;
    }
    if (key.backspace) {
      inputRef.current = inputRef.current.slice(0, -1);
      setInputValue(inputRef.current);
      return;
    }
    if (text.length > 0) {
      inputRef.current += text;
      setInputValue(inputRef.current);
    }
  });

  return (
    <Box flexDirection="column" minHeight={5}>
      {/* 消息/输出区（流式文本；T-042 换 markdown.tsx 渲染） */}
      <Box flexGrow={1} flexDirection="column">
        {assistantText.length > 0 && <Text>{assistantText}</Text>}
        {notices.map((notice, index) => (
          <Text key={index} color="yellow">
            {notice}
          </Text>
        ))}
        {error !== null && <Text color="red">错误：{error}</Text>}
      </Box>

      {/* 状态栏位（T-045 换成 status.tsx：模型名 / token 用量 / 权限模式） */}
      <Box>
        <Text dimColor>
          {running ? '● 运行中' : '○ 就绪'} · turn {lastTurn}
          {usage !== null &&
            ` · in ${usage.inputTokens ?? '?'} / out ${usage.outputTokens ?? '?'}`}
        </Text>
      </Box>

      {/* 底部输入行（T-041 换成 input.tsx：多行 / 粘贴 / 历史上翻 / 斜杠补全） */}
      <Box>
        <Text color="cyan">&gt; </Text>
        <Text>{inputValue}</Text>
      </Box>
    </Box>
  );
}
