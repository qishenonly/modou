# modou（墨斗）

> 弹好线，放手干。

**[English](README.md) · [简体中文](README-CN.md)**

**modou**（墨斗）是一个终端编码 Agent：读懂你的项目、和你一起规划、替你改文件、跑命令、并验证自己的成果——全程发生在你的终端里。

modou 的名字取自木工的**墨斗**——相传由鲁班发明的弹线工具。工匠把蘸墨的线绳绷紧一弹，在木料上留下笔直准线，木匠照线下料。modou 遵循同样的理念：**你弹线（意图、项目指令、权限边界），agent 照线干活，绝不越界。**

## 目录

- [特性](#特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [斜杠命令](#斜杠命令)
- [配置](#配置)
- [工作原理](#工作原理)
- [安全模型与局限](#安全模型与局限)
- [参与贡献](#参与贡献)

## 特性

- **极简、由模型驱动的 agent loop。** 没有工作流引擎、没有隐藏编排、没有意图分类器。模型负责决策，工具负责执行；所有「智能」来自模型、工具描述与系统提示词。
- **经过验证的内置工具集。** `Read`、`Write`、`Edit`、`Grep`（基于 ripgrep）、`Glob`、`Bash`——头部编码 Agent 共同验证的最小完备集。其余一切可插拔。
- **多供应商开箱即用。** Anthropic 与 OpenAI 兼容端点（DeepSeek / Kimi / Qwen / GLM，以及任意 `v1/chat/completions` 兼容服务）。适配器以契约测试兜底，供应商差异绝不渗透进 agent loop。
- **权限可调、默认安全。** 沙箱范围（只读 / 工作区可写 / 完全访问）× 审批策略（不信任 / 按需 / 从不）正交组合，叠加 allow/deny 规则表与硬性目录边界。安全是默认值，自主需要显式开启。
- **会话永不失忆。** 会话日志持久化、`/resume` 续聊、增量压缩（不塌缩上下文）、prompt caching，以及 `/context` 的分项 token 核算。
- **懂你的项目。** 读取 `AGENTS.md`（兼容 `CLAUDE.md`），按 全局 → 项目 → 子目录 三级叠加。

### 路线图

规划中（当前构建尚未包含）：MCP 工具、SKILL.md 技能、生命周期钩子、自定义斜杠命令、自定义 agent，以及 OS 级沙箱（见[安全模型与局限](#安全模型与局限)）。

## 环境要求

- **Bun 1.3+** —— modou 以 TypeScript 源码形式分发，`modou` / `mo` 可执行体由 Bun 运行（`npm` 仅负责安装）。
- **平台：** macOS 或 Linux。

## 安装

```bash
npm install -g modou
```

安装后提供两个命令 `modou` 与 `mo`，二者是同一个 TUI。想直接从源码体验最新版：

```bash
git clone <repo>
cd modou
bun install
bun run start
```

## 快速开始

```bash
cd your-project
modou
```

启动交互式终端界面（需要 TTY）。输入你的问题或指令，modou 会读懂你的项目、和你一起规划、替你改文件、跑命令。写入与命令执行会弹审批确认；危险命令**始终强制确认**——即使在「从不询问」策略下也一样。

首次使用先配置供应商与 API Key，例如 OpenAI 兼容端点：

```bash
export OPENAI_API_KEY=sk-...
modou
```

更完整的配置见[配置](#配置)：`settings.json`、`MODOU_*` 环境变量与 `AGENTS.md` 项目指令。

## 斜杠命令

| 命令                | 作用                                         |
| ------------------- | -------------------------------------------- |
| `/help`             | 列出全部斜杠命令与用法                       |
| `/model [模型ID]`   | 会话中途切换模型（无参数打开候选列表）       |
| `/compact`          | 压缩会话历史（把早期轮次折叠进摘要）         |
| `/resume [会话ID]`  | 恢复之前的会话（无参数列出候选）             |
| `/context [--json]` | 按分项查看 token 占用（`--json` 机器可读）   |
| `/clear`            | 开启全新会话（原会话日志保留，可 `/resume`） |

## 配置

modou 把两套机制分开：**配置**（给程序读的结构化设置）与**项目指令**（给模型读的自然语言）。

### settings.json

配置解析层级——后者覆盖前者：

1. 内置默认
2. `~/.modou/settings.json`（全局）
3. `<project>/.modou/settings.json`（项目）
4. `MODOU_*` 环境变量
5. CLI / TUI 选项

文件经过 schema 校验；未知字段或类型错误会给出友好报错，指明字段、期望值、所在文件与行号。

```json
{
  "provider": "openai-compat",
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com/v1",
  "permission": {
    "sandbox": "workspace-write",
    "policy": "on-request",
    "addDirs": ["/工作目录之外的绝对路径"],
    "rules": [
      { "effect": "allow", "match": "npm test" },
      { "effect": "deny", "match": "git push", "tool": "bash" }
    ]
  },
  "maxTurns": 10,
  "keepTurns": 6,
  "homeDir": "/绝对路径"
}
```

| 字段                 | 含义                                                   |
| -------------------- | ------------------------------------------------------ |
| `provider`           | `anthropic` 或 `openai-compat`（默认 `openai-compat`） |
| `model`              | 模型 ID（缺省回落环境变量）                            |
| `baseURL`            | 端点前缀（`openai-compat` 必需）                       |
| `permission.sandbox` | `read-only` · `workspace-write`（默认）· `full-access` |
| `permission.policy`  | `untrusted` · `on-request`（默认）· `never`            |
| `permission.addDirs` | 额外允许写入的目录（绝对路径）                         |
| `permission.rules`   | `allow` / `deny` 前缀规则，可选 `tool` 过滤            |
| `maxTurns`           | 每任务轮次上限（默认 10）                              |
| `keepTurns`          | 压缩后保留的近 N 轮原文（默认 6）                      |
| `homeDir`            | modou 数据根（会话/日志在 `<homeDir>/.modou` 下）      |

### 环境变量

`MODOU_*` 与设置字段一一对应，优先级高于文件；API Key 读标准供应商变量。

| 变量                | 含义                                        |
| ------------------- | ------------------------------------------- |
| `MODOU_PROVIDER`    | 供应商类型（`anthropic` / `openai-compat`） |
| `MODOU_MODEL`       | 模型 ID                                     |
| `MODOU_BASE_URL`    | 端点前缀                                    |
| `MODOU_SANDBOX`     | 沙箱范围                                    |
| `MODOU_POLICY`      | 审批策略                                    |
| `MODOU_ADD_DIRS`    | 额外可写目录（逗号分隔）                    |
| `MODOU_MAX_TURNS`   | 轮次上限                                    |
| `MODOU_KEEP_TURNS`  | 压缩后保留轮数                              |
| `MODOU_HOME_DIR`    | modou 数据根                                |
| `OPENAI_API_KEY`    | `openai-compat` 供应商的 API Key            |
| `ANTHROPIC_API_KEY` | Anthropic 供应商的 API Key                  |
| `OPENAI_BASE_URL`   | `openai-compat` 的可选端点兜底              |

### 项目指令（AGENTS.md）

模型的工作规则来自指令文件，从工作目录向上收集：

- `~/.modou/AGENTS.md` —— 全局层
- `<project>/AGENTS.md`（兼容 `CLAUDE.md`）—— 项目根与各级子目录

按 **全局 → 项目根 → 子目录** 顺序拼接；越靠近工作目录的规则越靠后（越有效）。总量上限 32KB——触顶截断时**会告警**，绝不静默。

## 工作原理

两个包，一条契约——外加消费它的界面：

- **`core`** — agent loop、工具执行管线、权限与上下文管理。零 UI 依赖，只对外发事件。
- **`tui`** — 基于 Ink 的终端界面（`modou` / `mo`），是 core 事件流的纯消费者。

界面里看到的一切都是**事件**，你做出的每个操作都是**命令**。这条窄契约让内核与前端彻底解耦——SDK、编辑器集成，都只是同一事件流的不同消费者。

所有副作用只走**一条工具管线**——权限、钩子、审计全部挂在唯一咽喉上，刻意不存在第二条路径。

## 安全模型与局限

- **沙箱范围：** 只读 · 工作区可写 · 完全访问
- **审批策略：** 不信任 · 按需 · 从不
- **规则表：** allow/deny 前缀匹配 + 内置危险命令黑名单（如 `rm -rf`、force-push）。危险命令即使在 `never` 策略下也**强制逐次确认**——「我信任这个 agent」不等于「我同意它执行 `rm -rf /`」。
- **目录边界：** 先解析真实路径（跟随符号链接、展开 `..`）再校验，杜绝字符串前缀绕过。

**诚实记录的限制。** shell 命令的前缀匹配是可以绕过的：`bash -c "rm -rf x"`、`eval $(echo cm0... | base64 -d)`、`;` 串联、别名——静态字符串匹配挡不住有意的绕过。因此规则表只是**「防手滑、防模型莽撞」的深度防御一层，不是安全边界**。真正的隔离依赖 1.0.0 的 OS 级沙箱（Seatbelt / Landlock / 容器）；在它交付之前，这段免责声明一直保留。换句话说：只在你可以接受数据丢失的目录里运行 modou；对任何在工作目录之外写文件或执行命令的审批弹窗，多看一眼再点。

## 参与贡献

欢迎提交 Issue 与 Pull Request。
