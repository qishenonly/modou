# Hooks 示例（0.14.0）

确定性脚本介入 agent 生命周期：模型不可靠的地方，用代码兜住。四个钩子点
（`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse`），外部
进程钩子通过 JSON 走 stdin/stdout 与内核通信，失败按声明的 failBehavior 降级
（ADR 0013）。

## 开箱示例（settings.json hooks 键注册）

```jsonc
// <project>/.modou/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": { "tools": ["bash"] },
        "command": "<repo>/scripts/hooks/block-dangerous.mjs",
        "failBehavior": "fail-closed",
      },
      {
        "matcher": { "tools": ["bash"] },
        "command": "<repo>/scripts/hooks/lint-before-commit.mjs",
        "env": { "MODOU_LINT_CMD": "bun run lint" },
        "timeoutMs": 30000,
        "failBehavior": "fail-open",
      },
    ],
    "PostToolUse": [
      {
        "matcher": { "tools": ["edit", "write"] },
        "command": "<repo>/scripts/hooks/format-after-edit.mjs",
        "env": { "MODOU_FORMAT_CMD": "bunx prettier --write" },
        "failBehavior": "fail-open",
      },
    ],
  },
}
```

| 脚本                     | 钩子点                    | 作用                                                                                                          | 失败语义                                    |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `block-dangerous.mjs`    | PreToolUse（bash）        | 拦截危险命令（`rm -rf /`、`git push --force`、`sudo`、fork 炸弹、`mkfs`、`shred`）——命中即 deny，理由回喂模型 | fail-closed（安全钩子：崩溃也要拦住）       |
| `lint-before-commit.mjs` | PreToolUse（bash）        | 拦截 `git commit`：先跑 lint（`MODOU_LINT_CMD`，缺省 `bun run lint`），通过才放行                             | fail-open（lint 脚本挂掉不该阻塞所有 bash） |
| `format-after-edit.mjs`  | PostToolUse（edit/write） | 编辑落盘后对文件跑格式化（`MODOU_FORMAT_CMD`），恒 continue                                                   | fail-open（format 挂掉不改变工具结果）      |

## JSON 契约（第二个对外契约，只能加字段）

输入（写 stdin，单行 JSON）：

```jsonc
{
  "v": 1,
  "point": "PreToolUse",
  "sessionId": "…",
  "cwd": "…",
  "toolName": "bash",
  "toolInput": { "command": "…" },
  "toolResult": { "ok": true, "forModel": "…" },
  "prompt": "…",
}
```

输出（stdout，按钩子点校验）：

```jsonc
// SessionStart
{ "decision": "proceed" | "block", "reason": "…" }
// UserPromptSubmit
{ "decision": "allow" | "block", "reason": "…", "additionalContext": "…" }
// PreToolUse
{ "decision": "allow" | "deny", "reason": "…", "modifiedInput": { … } }
// PostToolUse
{ "decision": "continue", "reason": "…" }
```

## 写自己的钩子

1. 脚本只读 stdin（单行 JSON）、写 stdout（单行 JSON），进程退出码 0 且输出合法
   即正常裁决；否则按 failBehavior 降级；
2. 尽量短时裁决（缺省超时 5000ms）；需要长任务请自持后台进程并快速返回；
3. 每次执行落执行日志 `~/.modou/logs/<project-hash>/hooks-<日期>.jsonl`
   （point / hookId / command / decision / degraded / reason / durationMs）；
4. 改写的参数（`modifiedInput`）会被重新校验，不合法按参数校验失败回喂模型。
