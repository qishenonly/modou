import { useEffect, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Command, Envelope, UsageData } from '@modou/core';
import { Input } from './input';
import { DEFAULT_FRAME_MS, Markdown, useFrameThrottledText } from './markdown';
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
}

/**
 * App：Ink 主应用（T-040 骨架）。
 *
 * 结构对齐 002 第十二节目录布局：
 * - 消息/输出区（markdown.tsx 流式渲染：语法高亮 + 帧节流，T-042）；
 * - 底部输入行（input.tsx：多行/粘贴/历史上翻/斜杠补全，T-041）；
 * - 状态栏位（本版内联一行占位，T-045 换成 status.tsx：模型名/token/权限模式）；
 * - tools.tsx / approval.tsx 分别由 T-043 / T-044 接入工具展示与审批弹窗。
 *
 * 键盘（T-041 分工）：
 * - App 层只管「全局键」：Esc 发 interrupt Command 打断当前轮、Ctrl+C 触发 onExit
 *   干净退出（headless 无键盘路径，不受影响）；
 * - 输入编辑（字符/换行/光标移动/历史上翻/斜杠补全）全部由 input.tsx 处理；
 * - 输入框提交：普通文本 → submit，以 `/` 开头 → slash（002 3.3 表）。
 *
 * 消费模型：事件流经 for-await 逐条应用（useEffect 内），卸载时置 disposed 停止。
 * 状态更新用函数式 setState，事件按 seq 到达即天然有序。
 */
export function App(props: AppProps): ReactElement {
  const { stream, send, onExit } = props;

  // 输出区：流式文本累计 + 帧节流（T-042 换 markdown 渲染，50ms 合并一次提交）
  const {
    text: assistantText,
    append: appendDelta,
    flush: flushDelta,
  } = useFrameThrottledText(DEFAULT_FRAME_MS);
  // 运行状态：由 turn_start / turn_end 推导（T-045 状态栏完善）
  const [running, setRunning] = useState(false);
  const [lastTurn, setLastTurn] = useState(0);
  // 最近一次 usage（T-045 状态栏消费；minimal 版只报 token）
  const [usage, setUsage] = useState<UsageData | null>(null);
  // 提示信息（配置告警、未知工具回馈等 notice 事件）
  const [notices, setNotices] = useState<string[]>([]);
  // 错误（002 5.3：错误即数据）
  const [error, setError] = useState<string | null>(null);
  // 工具调用条目（T-043：按 callId 组织 tool_call / tool_progress / tool_result，
  // 由 tools.tsx 的纯函数规约；跨轮次累计展示，与输出区文本同生命周期）
  const [tools, setTools] = useState<ToolCallEntry[]>([]);

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
          setUsage(envelope.data);
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
        default:
          // thinking_delta / approval_request / approval_resolved / context_state /
          // compaction 由 T-042（markdown 折叠）/ T-044（approval.tsx）后续处理。
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
  useInput((_text, key) => {
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

      {/* 状态栏位（T-045 换成 status.tsx：模型名 / token 用量 / 权限模式） */}
      <Box>
        <Text dimColor>
          {running ? '● 运行中' : '○ 就绪'} · turn {lastTurn}
          {usage !== null &&
            ` · in ${usage.inputTokens ?? '?'} / out ${usage.outputTokens ?? '?'}`}
        </Text>
      </Box>

      {/* 底部输入行（input.tsx：多行 / 粘贴 / 历史上翻 / 斜杠补全） */}
      <Box>
        <Text color="cyan">&gt; </Text>
        <Box flexGrow={1}>
          <Input onSubmit={handleSubmit} onSlash={handleSlash} />
        </Box>
      </Box>
    </Box>
  );
}
