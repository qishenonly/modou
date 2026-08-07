#!/usr/bin/env bun
import {
  createProviderFromEnv,
  defaultPermissionConfig,
  defaultWriteTools,
} from '@modou/core';
import { resolve } from 'node:path';
import { parseArgs, UsageError } from './args';
import type { CliArgs } from './args';
import { runHeadless } from './headless';
import type { HeadlessResult } from './headless';
import { createSignalInterrupt, signalToExitCode } from './signals';

const USAGE = `modou —— 终端编码 Agent（0.1.0）

用法：
  modou              进入交互式 TUI（Claude Code 式界面）
  modou -p "你好"    提交提示词，流式输出回答（headless）
  modou --auto-approve -p "修复一下某个 bug"   自动允许写入/执行（自用/评测用）

选项：
  -p, --prompt <文本>  要提交的提示词
  --auto-approve       跳过写入/执行审批（危险命令仍强制逐次确认）
  --add-dir <目录>     额外允许访问的目录（目录边界白名单，T-051；可重复，相对路径按启动 cwd 解析）
  -h, --help           显示本帮助`;

/**
 * CLI 入口：装配 → headless 运行。
 *
 * 退出码约定：
 * - 0：正常收尾（end_turn / halted）；
 * - 1：装配失败、运行失败（含供应商错误耗尽重试后终止、内部错误）；
 * - 2：参数错误；
 * - 130 / 143：被 SIGINT / SIGTERM 中断（POSIX 惯例 128 + 信号编号）。
 *
 * 中断（T-014）：SIGINT / SIGTERM 到达即 abort 贯穿链路的 AbortSignal，
 * 本轮终止为 interrupted，已产文本照常输出，进程以信号对应的退出码退出，
 * 不残留监听器（finally 里 dispose）。
 */
export async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (args.prompt === undefined) {
    // 0.4.0：无 -p 时进入交互式 TUI（Claude Code 式界面）。
    // TUI 是 core 事件流的纯消费者；写入/执行经审批弹窗（T-044），
    // 退出码由 TUI 的 Ctrl+C(0) / SIGINT(130) 路径决定。
    const { runTui } = await import('@modou/tui');
    const tui = await runTui({ tools: defaultWriteTools() });
    return tui.exitCode;
  }

  let provider;
  try {
    // 0.1.0 默认走 opencode 兼容端点（MODOU_OPENCODE_* 环境变量）；
    // 缺 key 时抛出的错误已含可判定的说明（如哪个环境变量缺失）。
    provider = createProviderFromEnv('openai-compat');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`模型装配失败：${message}\n`);
    return 1;
  }

  // 信号 → AbortSignal：SIGINT/SIGTERM 到达即打断当前轮（中断提示由
  // headless 的收尾摘要打印「── 已中断」）。
  const interrupt = createSignalInterrupt();

  let result: HeadlessResult;
  try {
    // T-051：--add-dir 扩展目录边界白名单。addDirs 转绝对路径（相对路径按启动 cwd
    // 解析），进入 PermissionConfig.addDirs；缺省（无 --add-dir）不覆盖权限配置，
    // headless 仍用其默认（workspace-write + on-request，projectRoot = cwd）。
    const permission =
      args.addDirs.length > 0
        ? {
            ...defaultPermissionConfig(process.cwd()),
            addDirs: args.addDirs.map((dir) => resolve(dir)),
          }
        : undefined;
    result = await runHeadless({
      provider,
      prompt: args.prompt,
      // 0.3.0：CLI 装配写/执行工具集（read/grep/glob/write/edit/bash），
      // `modou -p` 能改文件、能跑命令；审批策略由 --auto-approve 决定
      // （缺省 false = headless 默认拒绝，无人值守安全默认）。
      tools: defaultWriteTools(),
      autoApprove: args.autoApprove,
      ...(permission !== undefined ? { permission } : {}),
      abortSignal: interrupt.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`运行失败：${message}\n`);
    return 1;
  } finally {
    interrupt.dispose();
  }

  // 被信号打断：按 128 + 信号编号返回退出码
  if (interrupt.triggered !== undefined) {
    return signalToExitCode(interrupt.triggered);
  }
  // 供应商错误耗尽重试 / 内部错误：非 0 退出码
  if (result.result.termination === 'error') {
    return 1;
  }
  // 兜底：理论分支（termination=interrupted 但信号未记录）也保持非 0
  if (result.result.termination === 'interrupted') {
    return 130;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
