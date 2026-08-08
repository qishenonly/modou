#!/usr/bin/env node
/**
 * 示例钩子：提交前跑 lint（PreToolUse，建议 matcher.tools = ["bash"]）。
 *
 * 0.14.0 示例：拦截 `git commit`——提交前先跑 lint（环境变量 MODOU_LINT_CMD
 * 指定，缺省 `bun run lint`），lint 通过才放行 commit（deny 理由回喂模型，
 * 模型据此先修 lint 问题再重试）。
 *
 * 输入（stdin 单行 JSON）：{ v, point, toolName, toolInput: { command } }
 * 输出（stdout 单行 JSON）：{ decision: 'allow' | 'deny', reason? }
 *
 * 使用（settings.json）：
 *   { "hooks": { "PreToolUse": [ {
 *       "matcher": { "tools": ["bash"] },
 *       "command": "<repo>/scripts/hooks/lint-before-commit.mjs",
 *       "env": { "MODOU_LINT_CMD": "bun run lint" },
 *       "timeoutMs": 30000,
 *       "failBehavior": "fail-open"
 *     } ] } }
 */
import { execFileSync } from 'node:child_process';

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  data += c;
});
process.stdin.on('end', () => {
  const input = JSON.parse(data);
  const command = input.toolInput?.command ?? '';
  if (!/\bgit\s+commit\b/.test(command)) {
    // 非 commit 命令直通（匹配器已把范围收窄到 bash，这里只拦 commit）
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }
  const lintCmd = process.env.MODOU_LINT_CMD ?? 'bun run lint';
  const [cmd, ...args] = lintCmd.split(/\s+/);
  try {
    // 继承进程 cwd = 项目根；30s 超时
    execFileSync(cmd, args, { stdio: 'pipe', timeout: 30_000 });
    process.stdout.write(
      JSON.stringify({ decision: 'allow', reason: 'lint 通过' }),
    );
  } catch (error) {
    const stderr = String(error.stderr ?? '')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(0, 5)
      .join('\n');
    process.stdout.write(
      JSON.stringify({
        decision: 'deny',
        reason: `提交前 lint 未通过${stderr ? `：\n${stderr}` : '（无输出）'}。请先修复 lint 问题，再重试 git commit。`,
      }),
    );
  }
});
