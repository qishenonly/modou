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
  // 绝不假装能渲染、也不静默吞掉输入。退出码 2（用法错误类）。
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    console.error(
      '[modou] 检测到非 TTY 环境：交互式 TUI 需要真实终端。',
    );
    console.error(
      '  请改用程序化 API（脚本 / CI 友好）：',
    );
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
    process.exitCode = 2;
    process.exit(0);
  }
  try {
    process.exitCode = await runTui({ tools: defaultWriteTools() }).then(
      (result) => result.exitCode,
    );
  } catch (error) {
    // T-080：启动期配置校验失败等以可读消息打到 stderr，退出码 1。
    // SettingsValidationError 的 message 已带字段 / 期望 / 文件行号。
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[modou] ${message}`);
    process.exitCode = 1;
  }
}
