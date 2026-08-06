#!/usr/bin/env bun
import { createProviderFromEnv } from '@modou/core';
import { parseArgs, UsageError } from './args';
import type { CliArgs } from './args';
import { runHeadless } from './headless';

const USAGE = `modou —— 终端编码 Agent（0.1.0）

用法：
  modou -p "你好"    提交提示词，流式输出回答（headless）

选项：
  -p, --prompt <文本>  要提交的提示词
  -h, --help           显示本帮助`;

/**
 * CLI 入口：装配 → headless 运行。
 * 退出码：0 正常；1 装配/运行失败；2 参数错误。
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
    process.stderr.write(`缺少 -p/--prompt 参数。\n\n${USAGE}\n`);
    return 2;
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

  try {
    await runHeadless({ provider, prompt: args.prompt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`运行失败：${message}\n`);
    return 1;
  }

  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
