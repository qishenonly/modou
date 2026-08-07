#!/usr/bin/env bun
/**
 * modou 可执行入口（TUI 为唯一前端，2026-08-06 起不再有 cli 包）。
 *
 * 装配写/执行工具集（read/grep/glob/write/edit/bash），写入与命令执行
 * 经 TUI 审批弹窗（T-044）裁决；危险命令由 core 强制逐次确认。
 */
import { defaultWriteTools } from '@modou/core';
import { runTui } from './index';

if (import.meta.main) {
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
