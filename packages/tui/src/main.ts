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
  process.exitCode = await runTui({ tools: defaultWriteTools() }).then(
    (result) => result.exitCode,
  );
}
