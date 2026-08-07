# modou（墨斗）

> Snap the line, let it cut.

**[English](README.md) · [简体中文](README-CN.md)**

**modou** is a coding agent that lives in your terminal. It reads your project, plans changes with you, edits files, runs commands, and verifies its own work — all from the comfort of your terminal.

modou is named after the carpenter's ink line — _墨斗_, a marking tool attributed to the ancient Chinese craftsman Lu Ban. A carpenter snaps a taut, ink-soaked string to leave a straight guideline on the timber, then cuts along it. modou works the same way: **you snap the line — intent, project instructions, permission boundaries — and the agent cuts along it, never silently crossing the bounds you set.**

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Slash Commands](#slash-commands)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Security Model & Limitations](#security-model--limitations)
- [Contributing](#contributing)

## Features

- **A minimal, model-driven agent loop.** No workflow engine, no hidden orchestration, no intent classifiers. The model drives; the tooling follows. All of the "intelligence" lives in the model, the tool descriptions, and the system prompt.
- **A proven built-in toolset.** `Read`, `Write`, `Edit`, `Grep` (ripgrep-powered), `Glob`, and `Bash` — the minimal complete set validated by the leading coding agents in the field. Everything else plugs in.
- **Multi-provider from day one.** Anthropic and OpenAI-compatible endpoints (DeepSeek / Kimi / Qwen / GLM, and any `v1/chat/completions`-compatible service). Contract-tested adapters absorb provider differences so they never leak into the agent loop.
- **Permissions you can tune — safe by default.** Three sandbox scopes (read-only / workspace-write / full-access) × three approval policies (untrusted / on-request / never), stacked allow/deny rules, and a hard directory boundary. Safety is the default; autonomy is opt-in.
- **Sessions that never forget.** Persistent session logs, `/resume`, incremental context compaction (no context collapse), prompt caching, and per-section token accounting via `/context`.
- **Knows your project.** Reads `AGENTS.md` (with `CLAUDE.md` compatibility), stacked global → project → subdirectory.

### Roadmap

Planned (not yet in this build): MCP tools, SKILL.md skills, lifecycle hooks, custom slash commands, custom agents, and an OS-level sandbox (see [Security Model](#security-model--limitations)).

## Requirements

- **Bun 1.3+** — modou ships as TypeScript source; the `modou` / `mo` executables run under Bun. (`npm` is only used to install the package.)
- **Platform:** macOS or Linux.

## Installation

```bash
npm install -g modou
```

This provides two commands, `modou` and `mo` — they are the same TUI. To try the latest from source instead:

```bash
git clone <repo>
cd modou
bun install
bun run start
```

## Quick Start

```bash
cd your-project
modou
```

This launches the interactive terminal UI (a TTY is required). Type your question or instruction, and modou reads your project, plans changes with you, edits files, and runs commands. Write and execute actions go through an approval prompt; dangerous commands always require confirmation — even when the model is running under a "never ask" policy.

First-run configuration: set the provider and API key, e.g. for an OpenAI-compatible endpoint:

```bash
export OPENAI_API_KEY=sk-...
modou
```

See [Configuration](#configuration) for `settings.json`, `MODOU_*` environment variables, and `AGENTS.md` project instructions.

## Slash Commands

| Command               | Description                                                         |
| --------------------- | ------------------------------------------------------------------- |
| `/help`               | List all available slash commands and usage                         |
| `/model [modelID]`    | Switch models mid-session (no argument opens a picker)              |
| `/compact`            | Compact the session history (fold early turns into a summary)       |
| `/resume [sessionID]` | Resume a previous session (no argument lists candidates)            |
| `/context [--json]`   | Inspect token usage by section (`--json` for machine-readable)      |
| `/clear`              | Start a fresh session (the old session log is kept, `/resume`-able) |

## Configuration

modou separates two mechanisms: **configuration** (structured settings the program reads) and **project instructions** (natural language the model reads).

### settings.json

Configuration layers — each overrides the previous:

1. Built-in defaults
2. `~/.modou/settings.json` (global)
3. `<project>/.modou/settings.json` (project)
4. `MODOU_*` environment variables
5. CLI / TUI options

Files are schema-validated; unknown fields or wrong types produce a friendly error naming the field, the expected value, the file, and the line.

```json
{
  "provider": "openai-compat",
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com/v1",
  "permission": {
    "sandbox": "workspace-write",
    "policy": "on-request",
    "addDirs": ["/absolute/path/outside/workdir"],
    "rules": [
      { "effect": "allow", "match": "npm test" },
      { "effect": "deny", "match": "git push", "tool": "bash" }
    ]
  },
  "maxTurns": 10,
  "keepTurns": 6,
  "homeDir": "/absolute/path/to/home"
}
```

| Field                | Meaning                                                         |
| -------------------- | --------------------------------------------------------------- |
| `provider`           | `anthropic` or `openai-compat` (default `openai-compat`)        |
| `model`              | Model ID (falls back to environment variables)                  |
| `baseURL`            | Endpoint prefix (required for `openai-compat`)                  |
| `permission.sandbox` | `read-only` · `workspace-write` (default) · `full-access`       |
| `permission.policy`  | `untrusted` · `on-request` (default) · `never`                  |
| `permission.addDirs` | Extra directories the agent may write to (absolute paths)       |
| `permission.rules`   | `allow` / `deny` prefix rules, optional `tool` filter           |
| `maxTurns`           | Turn limit per task (default 10)                                |
| `keepTurns`          | Recent turns kept verbatim after compaction (default 6)         |
| `homeDir`            | modou data root (sessions / logs live under `<homeDir>/.modou`) |

### Environment variables

`MODOU_*` variables mirror the settings fields and override files. API keys are read from standard provider variables.

| Variable            | Meaning                                        |
| ------------------- | ---------------------------------------------- |
| `MODOU_PROVIDER`    | Provider type (`anthropic` / `openai-compat`)  |
| `MODOU_MODEL`       | Model ID                                       |
| `MODOU_BASE_URL`    | Endpoint prefix                                |
| `MODOU_SANDBOX`     | Sandbox scope                                  |
| `MODOU_POLICY`      | Approval policy                                |
| `MODOU_ADD_DIRS`    | Extra writable directories (comma-separated)   |
| `MODOU_MAX_TURNS`   | Turn limit                                     |
| `MODOU_KEEP_TURNS`  | Turns kept verbatim after compaction           |
| `MODOU_HOME_DIR`    | modou data root                                |
| `OPENAI_API_KEY`    | API key for `openai-compat` providers          |
| `ANTHROPIC_API_KEY` | API key for Anthropic providers                |
| `OPENAI_BASE_URL`   | Optional base-URL fallback for `openai-compat` |

### Project instructions (`AGENTS.md`)

The model's working rules come from instruction files, collected from the working directory upward:

- `~/.modou/AGENTS.md` — global layer
- `<project>/AGENTS.md` (or `CLAUDE.md` as a compatible fallback) — project root and each subdirectory

They are concatenated in the order **global → project root → subdirectory**; rules closer to your working directory take effect later (and win). The total is capped at 32 KB — if the cap is hit, truncation is announced rather than silent.

## How It Works

Two packages, one contract — plus the UI that consumes it:

- **`core`** — the agent loop, the tool pipeline, permissions, and context management. Zero UI dependencies; it only emits events.
- **`tui`** — the Ink-based terminal interface (`modou` / `mo`). A pure consumer of the core event stream.

Everything the interface shows is an _event_; everything you do is a _command_. This single, narrow contract keeps the core UI-agnostic — an SDK and editor integration would be different consumers of the same stream.

All side effects flow through a single tool pipeline — the one choke point where permissions, hooks, and audit attach. There is deliberately no second path.

## Security Model & Limitations

- **Sandbox scopes:** read-only · workspace-write · full-access
- **Approval policies:** untrusted · on-request · never
- **Rules:** stacked allow/deny prefixes plus a built-in danger-command blacklist (e.g. `rm -rf`, force-push). Dangerous commands force confirmation even under the `never` policy — trusting the agent is not the same as approving `rm -rf /`.
- **Path boundary:** real paths are resolved (symlinks followed, `..` expanded) before any check — no string-prefix tricks.

**Honest limitations.** Shell-command prefix matching can be bypassed: `bash -c "rm -rf x"`, `eval $(echo cm0... | base64 -d)`, `;`-chaining, aliases — static string matching cannot stop a deliberate attacker. The rules table is therefore a **defense-in-depth layer against accidents and model recklessness, not a security boundary**. Real isolation depends on an OS-level sandbox (Seatbelt / Landlock / container), which is planned for 1.0.0; until that ships, this disclaimer stays. In other words: only run modou in directories whose contents you are willing to lose, and review approval prompts that write files or execute commands outside your working directory.

## Contributing

Issues and pull requests are welcome.
