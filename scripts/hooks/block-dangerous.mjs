#!/usr/bin/env node
/**
 * 示例钩子：拦截危险命令（PreToolUse，建议 matcher.tools = ["bash"]）。
 *
 * 0.14.0 示例：模型不可靠的地方用代码兜住——0.4.0 的 deny 前缀匹配挡不住
 * `bash -c` 绕过，这里做任意复杂解析：命令命中危险模式即 deny（理由回喂模型，
 * 模型不会重试同样的操作）。
 *
 * 输入（stdin 单行 JSON）：{ v, point, toolName, toolInput: { command } }
 * 输出（stdout 单行 JSON）：{ decision: 'allow' | 'deny', reason? }
 *
 * 使用（settings.json）：
 *   { "hooks": { "PreToolUse": [ {
 *       "matcher": { "tools": ["bash"] },
 *       "command": "<repo>/scripts/hooks/block-dangerous.mjs",
 *       "failBehavior": "fail-closed"
 *     } ] } }
 */
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  data += c;
});
process.stdin.on('end', () => {
  const input = JSON.parse(data);
  const command = input.toolInput?.command ?? '';
  const reason = inspect(command);
  if (reason !== null) {
    process.stdout.write(JSON.stringify({ decision: 'deny', reason }));
  } else {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
  }
});

/** 危险模式表：命中即 deny（模式 + 给模型 / 用户看的中文说明）。 */
function inspect(command) {
  const patterns = [
    {
      re: /\brm\s+-[rf]+\s+\/(\s|$)/,
      msg: '递归强制删除根路径（rm -rf /…）',
    },
    {
      re: /\bgit\s+push\b.*(--force|-f)\b/,
      msg: '强制推送（--force）可能覆盖远端历史',
    },
    { re: /\bsudo\b/, msg: 'sudo 提权操作' },
    { re: /:\s*\(\s*\)\s*\{[^}]*\};/, msg: 'fork 炸弹' },
    { re: /\bmkfs(?:\s|$)/, msg: '格式化磁盘（mkfs）' },
    { re: /\bshred\b/, msg: 'shred 覆写删除文件' },
  ];
  for (const pattern of patterns) {
    if (pattern.re.test(command)) {
      return `危险命令被拦截（示例钩子 block-dangerous）：${pattern.msg}。被拒绝，别重试同样的操作；如需执行请先向用户说明。`;
    }
  }
  return null;
}
