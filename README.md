# modou（墨斗）

> Snap the line, let it cut.

**[English](README.md) · [简体中文](README-CN.md)**

**modou** is a local-first coding agent. Its primary form is a **desktop GUI** — Electron + React with a Claude Desktop–style layout — that reads your project, plans changes with you, edits files, runs commands, and verifies its own work. All reads and writes stay inside the directories you authorize, with a visible security boundary.

modou is named after the carpenter's ink line — _墨斗_, a marking tool attributed to the ancient Chinese craftsman Lu Ban. A carpenter snaps a taut, ink-soaked string to leave a straight guideline on the timber, then cuts along it. modou works the same way: **you snap the line — intent, project instructions, permission boundaries — and the agent cuts along it, never silently crossing the bounds you set.**

## Table of Contents

- [Core Capabilities (GUI)](#core-capabilities-gui)
- [Under the Hood (core)](#under-the-hood-core)
- [Requirements](#requirements)
- [Install & Run](#install--run)
- [Quick Start](#quick-start)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Slash Commands](#slash-commands)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Security Model & Limitations](#security-model--limitations)
- [Contributing](#contributing)

## Core Capabilities (GUI)

### Chat

- **Streaming replies** with Markdown rendering, automatic code highlighting (hljs), and copy buttons on every code block — including blocks without a language tag.
- **Thinking** is collapsed under a foldable "thinking" section so it never interrupts the main text.
- **Inline tool cards**: Edit shows before/after diffs, Bash shows the command and exit code, web tools mark their sources — tools appear in the conversation in execution order, as naturally as Q&A.
- **Todo list** with live progress updates across turns.
- **Sub-agent timeline**: role-based sub-agents collapse into activity summaries; expanding shows process text and the tools they called (tool-name chips).
- **Context gauge**: a slim progress bar atop the chat shows context usage / model window, with 70% / 90% warning tiers, a red near-compaction state, and a hover breakdown.
- **Plan-mode card**: `/plan` produces a structured plan you can approve / modify / reject right in the conversation.
- **Per-message actions**: hover any message for "Copy" (assistant messages also offer "Regenerate", user messages offer "Edit" to refill the input).

### Sidebar (Sessions)

- **Project switching**: one directory = one project; switch anytime from the top-left, and modou only ever touches directories you authorized.
- **Full-text session search**: the search box searches session **content**, not just titles, showing snippets and hit counts; one click switches to **all-projects search** (results are labeled with their project).
- **Hit jumping**: clicking a search result restores that session and auto-scrolls to — and briefly highlights — the matching message.
- **Session management**: keyboard navigation (↑/↓ + Enter), multi-select delete, rename, and a context menu (restore / rename / archive / export / delete / copy ID).
- **Archive**: archived sessions hide from the main list but stay recoverable — history is never lost, and the list stays clean.
- **Export**: export an entire session as Markdown for sharing, archiving, or handoff.
- **Scheduled tasks / usage** accessible right from the sidebar.

### Input

- **Image + file attachments**: paste, drag, or pick from a button; images are attached as images, text files (code, docs, config…) are read into the message, and unsupported types are skipped with an explicit notice.
- **One-click permission switching**: a popover on the input row lets you pick sandbox × approval policy (read-only / workspace-write / full-access × ask-each / on-request / never) — effective immediately.
- **Slash-command hints** appear when you type `/`.
- **Cmd+K command palette**: one search box finds three kinds of entries — slash commands, history sessions, and project files; arrow keys + Enter to run, Esc to close.

### File Panel (Cmd+Shift+F)

- **Files view**: a recursive file tree (respecting ignore rules); click a file to preview it inline (binary and oversized files get graceful fallbacks).
- **Changes view**: lists all uncommitted changes from the git working tree (`git status` + `git diff`), with per-file unified diffs; files the agent edited this turn are marked "edited this turn" even if they aren't in git changes.

### Models & Extensions

- **Multi-provider model management**: Anthropic / OpenAI-compatible endpoints (DeepSeek, Kimi, Qwen, GLM, any relay, Ollama…); pull model lists from upstream `/models`; switch anytime from the **status-bar model dropdown**.
- **Settings panel**: Models / Permissions & Security / Context / MCP / Hooks / Skills / Agents / Appearance / Shortcuts / About.
- **Visual MCP management**: connection states at a glance (connected / connecting / failed), plus add, delete, enable/disable, and risk-level configuration.
- **Skills (SKILL.md)**: on-demand "how-to" knowledge; add extra skill directories by path or with a one-click **Browse… import**.
- **Custom agents**: `.modou/agents/*.md` role definitions, created / edited / deleted right in the GUI.
- **Hooks**: lifecycle hooks (SessionStart / UserPromptSubmit / PreToolUse / PostToolUse) configured visually.
- **Long-term memory**: file-based notes (`.modou/memory/`) loaded across sessions.
- **Web tools**: WebSearch / WebFetch with domain allow/deny lists and redirect guards.

### Automation & Feedback

- **Scheduled tasks**: cron-driven recurring tasks ("run the nightly self-audit at 10pm"), managed in a panel.
- **Completion notifications**: long tasks post a system notification (with elapsed time) when the window is unfocused.
- **Usage & cost**: a usage panel (token charts) plus `/cost` accounting (by day and by session).
- **Theme**: light / dark / follow system.

## Under the Hood (core)

The GUI and the terminal UI (TUI) share the same core (event-stream protocol: Event↑ / Command↓, so the frontend is replaceable):

- **A minimal agent loop** — no workflow engine, no hidden orchestration: the model decides, tools execute.
- **Built-in tools**: `Read` / `Write` / `Edit` / `Grep` (ripgrep) / `Glob` / `Bash` / `Task` / `Todo` / `Skill` / `Agent` / `Memory` / `WebSearch` / `WebFetch` / MCP.
- **Orthogonal permission model**: sandbox scope × approval policy + allow/deny rules + mandatory confirmation for dangerous commands.
- **Sessions never forget**: persistence, `/resume`, incremental compaction, prompt caching, and `/context` itemized accounting.
- **Snapshot rollback**: `/rewind` restores the project to any historical snapshot, undoing the agent's changes.
- **Plan mode**: `/plan` research → structured plan → execute after approval.
- **Multi-provider**: provider differences are absorbed in an adapter layer, guarded by contract tests.
- **Open extension standards**: MCP / AGENTS.md / SKILL.md.

## Requirements

- **Platform**: macOS or Linux.
- **GUI (recommended)**: Node.js 18+ (Electron) and Bun 1.3+ (build / test).
- **CLI (TUI)**: Bun 1.3+ (TypeScript source runs directly).

## Install & Run

```bash
git clone <repo>
cd modou
bun install
```

**Desktop GUI**

```bash
bun run gui          # build + launch (production)
# or dev mode (hot reload):
bun run gui:dev
```

**Terminal CLI**

```bash
bun run start        # equivalent to modou / mo
```

## Quick Start

1. Launch the GUI and pick a project directory on first run (one directory = one project).
2. Open "Settings → Models": add a provider (Anthropic or an OpenAI-compatible endpoint) → pull the model list from upstream → set one as current.
3. Back in the chat, type your task and press Enter.

```text
Help me understand this project's structure and add unit tests to the core modules
```

modou will read the project, plan, edit files, run commands, and verify — writes and command execution prompt for approval, and dangerous commands are **always confirmed**, even under "never ask".

## Keyboard Shortcuts

| Shortcut                | Action                                            |
| ----------------------- | ------------------------------------------------- |
| `⌘K`                    | Command palette (commands / sessions / files)     |
| `⌘N`                    | New chat                                          |
| `⌘,`                    | Settings                                          |
| `⌘⇧O`                   | Model management                                  |
| `⌘⇧T`                   | Scheduled tasks                                   |
| `⌘U`                    | Usage                                             |
| `⌘\`                    | Toggle sidebar                                    |
| `⌘⇧F`                   | File panel                                        |
| `Esc`                   | Stop generation / close dialogs / reject approval |
| `Enter` / `Shift+Enter` | Send / newline                                    |
| `↑ / ↓`                 | Input history / session list navigation           |

## Slash Commands

| Command                  | Action                                                        |
| ------------------------ | ------------------------------------------------------------- |
| `/help`                  | List all slash commands and usage                             |
| `/model [model]`         | Switch models (no arg opens candidates)                       |
| `/compact`               | Manually trigger context compaction                           |
| `/resume [session]`      | Resume a previous session                                     |
| `/context [--json]`      | Itemized token usage                                          |
| `/clear`                 | Start a fresh session (logs are kept, resumable)              |
| `/rewind`                | List snapshot points, preview diffs, restore files            |
| `/snapshots [--cleanup]` | Snapshot usage & retention policy                             |
| `/plan [request]`        | Plan mode: research → structured plan → approve/modify/reject |
| `/init`                  | Probe the repo and draft an `AGENTS.md`                       |
| `/image <path \| URL>`   | Start a turn with an image input                              |
| `/cost`                  | Cost accounting (session + per-day)                           |
| `/mcp`                   | MCP server connection status                                  |

## Configuration

modou separates two mechanisms: **configuration** (structured settings for the program) and **project instructions** (natural language for the model).

### settings.json

Layered — later wins:

1. Built-in defaults
2. `~/.modou/settings.json` (global)
3. `<project>/.modou/settings.json` (project)
4. `MODOU_*` environment variables
5. CLI / GUI options

```json
{
  "provider": "openai-compat",
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com/v1",
  "permission": {
    "sandbox": "workspace-write",
    "policy": "on-request",
    "rules": [
      { "effect": "allow", "match": "npm test" },
      { "effect": "deny", "match": "git push", "tool": "bash" }
    ]
  },
  "mcp": {
    "servers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/repo"],
        "risk": "read"
      }
    }
  },
  "web": {
    "allowedDomains": ["example.com"],
    "deniedDomains": ["ads.example.com"],
    "timeoutMs": 15000,
    "maxBytes": 262144
  },
  "maxTurns": 10,
  "keepTurns": 6
}
```

### Environment variables

`MODOU_*` maps one-to-one to settings fields and takes precedence over files; API keys come from standard provider variables (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`).

### Project instructions (`AGENTS.md`)

The model's working rules come from instruction files collected upward from the working directory: global `~/.modou/AGENTS.md` → project root → subdirectories (`CLAUDE.md` is compatible). Total limit 32KB; truncation warns, never silently.

### Skills (`SKILL.md`) · Custom agents · Memory

- **Skills**: follow the open [Agent Skills](https://agentskills.io) standard — drop a directory containing `SKILL.md` into any layer and it takes effect; progressive disclosure (only name + description stay in context; the body loads on demand).
- **Agents**: `.modou/agents/<name>.md` (frontmatter: name / description / allowedTools / model + body prompt); the tool whitelist is truly enforced.
- **Memory**: plain-text notes at `.modou/memory/<key>.md`, written/read via `memory_write / read / list`, injected at session start.

## How It Works

Two packages, one contract — plus the frontends that consume it:

- **`core`** — the agent loop, tool pipeline, permissions, and context management. Zero UI dependencies; it only emits events.
- **`tui`** — the Ink-based terminal UI (`modou` / `mo`).
- **`gui`** — the Electron + React desktop UI (Claude Desktop–style layout), the primary product form.

Everything you see in the UI is an **event**; every action you take is a **command**. This contract fully decouples the kernel from the frontend — the GUI, the TUI, and any future SDK / editor integration are all just different consumers of the same event stream.

All side effects flow through **one tool pipeline** — permissions, hooks, and audit all hang off the single choke point; a second path deliberately does not exist.

## Security Model & Limitations

- **Sandbox scope**: read-only · workspace-write · full-access
- **Approval policy**: ask-each · on-request · never
- **Rules table**: allow/deny prefix matching + a built-in dangerous-command blocklist (e.g. `rm -rf`, force-push). Dangerous commands are **always confirmed one at a time**, even under "never".
- **Directory boundary**: real paths are resolved first (symlinks followed, `..` expanded) before checking, preventing string-prefix bypasses.
- **MCP / web boundary**: MCP tools run outside the sandbox boundary — the default `network` risk requires approval, with a source prefix in the approval dialog; web tools require approval by default, with domain whitelists and per-hop redirect checks, and fetched content is marked as external data (data, not instructions).

**Honest limitations.** Shell command prefix matching can be bypassed: `bash -c "rm -rf x"`, `eval`, `;` chains, aliases — static string matching cannot stop deliberate circumvention. The rules table is therefore a defense-in-depth layer against slips and model recklessness, not a security boundary. Real isolation awaits OS-level sandboxing (Seatbelt / Landlock / containers); until then: only run modou in directories where data loss is acceptable, and read approval dialogs that write or execute outside the working directory carefully.

## Contributing

Issues and pull requests are welcome.
