#!/usr/bin/env node
/**
 * 示例钩子：编辑后自动 format（PostToolUse，建议 matcher.tools = ["edit", "write"]）。
 *
 * 0.14.0 示例：PostToolUse 是观察 / 副作用挂载点——工具结果已产生、无法撤销，
 * 钩子恒返回 continue。这里对改写的文件跑格式化命令（环境变量 MODOU_FORMAT_CMD
 * 指定，缺省不格式化），format 失败不改变工具结果（副作用钩子失败不应拖死任务）。
 *
 * 输入（stdin 单行 JSON）：{ v, point, toolName, toolInput: { path }, toolResult }
 * 输出（stdout 单行 JSON）：{ decision: 'continue', reason? }
 *
 * 使用（settings.json）：
 *   { "hooks": { "PostToolUse": [ {
 *       "matcher": { "tools": ["edit", "write"] },
 *       "command": "<repo>/scripts/hooks/format-after-edit.mjs",
 *       "env": { "MODOU_FORMAT_CMD": "bunx prettier --write" },
 *       "failBehavior": "fail-open"
 *     } ] } }
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  data += c;
});
process.stdin.on('end', () => {
  const input = JSON.parse(data);
  const path = input.toolInput?.path;
  const formatCmd = process.env.MODOU_FORMAT_CMD;
  if (typeof path === 'string' && formatCmd !== undefined && existsSync(path)) {
    const [cmd, ...args] = formatCmd.split(/\s+/);
    try {
      // 对改写的文件跑格式化命令（继承进程 cwd = 项目根）
      execFileSync(cmd, [...args, path], { stdio: 'pipe', timeout: 30_000 });
    } catch {
      // format 失败不改变工具结果；执行日志已由执行器记录
    }
  }
  process.stdout.write(JSON.stringify({ decision: 'continue' }));
});
