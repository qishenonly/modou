#!/usr/bin/env bun
/**
 * modou 可执行入口（TUI 为唯一前端，2026-08-06 起不再有 cli 包）。
 *
 * 装配写/执行工具集（read/grep/glob/write/edit/bash），写入与命令执行
 * 经 TUI 审批弹窗（T-044）裁决；危险命令由 core 强制逐次确认。
 *
 * CLI 参数（T-092 打包分发补充）：`--version` / `-v` 与 `--help` / `-h`
 * 在启动 TUI 前处理——打包后的 `npx modou` 在无 TTY 环境下用 `--version`
 * 冒烟验证安装与 bin 链接（TUI 本体需要 TTY）。交互入口不带参数直接进 TUI。
 */
import { defaultWriteTools } from '@modou/core';
import { StructuredLogger } from '@modou/core';
import { runTui, version } from './index';

const USAGE = `modou ${version} — 终端编码 Agent

用法:
  modou                启动交互式 TUI（需要 TTY）
  modou --version      输出版本号后退出
  modou --help         显示本帮助后退出

配置: ~/.modou/settings.json 与 <project>/.modou/settings.json（schema 见
  docs/design/002-architecture.md 九节），MODOU_* 环境变量（MODOU_PROVIDER /
  MODOU_MODEL / MODOU_BASE_URL / MODOU_SANDBOX / MODOU_POLICY / MODOU_MAX_TURNS …）。

斜杠命令: /help /model /compact /resume /context /clear`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    console.log(`modou ${version}`);
    process.exit(0);
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  // T-131 CI 友好化：无 TTY 自动降级——交互式 TUI 需要终端，管道 / CI 环境下
  // 明确报错并提示改用程序化 API（runAgentTurnJson + readStdinPrompt），
  // 绝不假装能渲染、也不静默吞掉输入。退出码 1（失败 / 用法错误类）——不再与
  // 语义退出码的「2 超限」混用（0.13.0 必修：2 只留给 runAgentTurnJson 的 halted）。
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    console.error('[modou] 检测到非 TTY 环境：交互式 TUI 需要真实终端。');
    console.error('  请改用程序化 API（脚本 / CI 友好）：');
    console.error(
      '    import { runAgentTurnJson, readStdinPrompt } from "@modou/core";',
    );
    console.error(
      '    const prompt = await readStdinPrompt(); // echo "任务" | modou 的管道形态',
    );
    console.error(
      '    const { exitCode } = await runAgentTurnJson({ provider, messages: [{ role: "user", content: prompt }], options: { maxTurns: 10 } });',
    );
    console.error(
      '  退出码：0 成功 / 1 失败 / 2 超限 / 3 需审批（默认拒绝，ADR 0012）/ 130 中断。',
    );
    // 直接 process.exit(1)（而非 exitCode + process.exit(0)）——后者会被
    // exit(0) 覆写为 0，静默吞掉失败信号。
    process.exit(1);
  }
  // 建议 0.13.0：二进制默认装配结构化日志——`~/.modou/logs/<project-hash>/` 下
  // JSONL 追加写（request / tool_call / permission 三类，design 002 十一节）。
  // 成本低（旁路记录，仅多一个目录 + 追加写），审计可回溯：每次请求的 token
  // 分项 / 每次工具调用 / 每次权限裁决都有据可查。装配失败只告警不打断 TUI——
  // 日志是旁路，绝不因日志问题影响主流程（写失败经 logger 的 onError 报 stderr）。
  let structuredLog: StructuredLogger | undefined;
  try {
    structuredLog = new StructuredLogger();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[modou] 结构化日志装配失败（不影响使用）：${message}`);
  }
  try {
    process.exitCode = await runTui({
      tools: defaultWriteTools(),
      ...(structuredLog !== undefined ? { structuredLog } : {}),
    }).then((result) => result.exitCode);
  } catch (error) {
    // T-080：启动期配置校验失败等以可读消息打到 stderr，退出码 1。
    // SettingsValidationError 的 message 已带字段 / 期望 / 文件行号。
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[modou] ${message}`);
    process.exitCode = 1;
  } finally {
    // 退出前等待已排队条目全部落盘（close 幂等：置 closed 后 flush 队列）。
    await structuredLog?.close();
  }
}
