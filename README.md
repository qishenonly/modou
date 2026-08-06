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
- [How It Works](#how-it-works)
- [Security](#security)
- [Contributing](#contributing)

## Features

- **A minimal, model-driven agent loop.** No workflow engine, no hidden orchestration, no intent classifiers. The model drives; the tooling follows. All of the "intelligence" lives in the model, the tool descriptions, and the system prompt.
- **A proven built-in toolset.** `Read`, `Write`, `Edit`, `Grep` (ripgrep-powered), `Glob`, and `Bash` — the minimal complete set validated by the leading coding agents in the field. Everything else plugs in.
- **Multi-provider from day one.** Anthropic, OpenAI-compatible endpoints, DeepSeek / Kimi / Qwen / GLM, and local models via Ollama. Contract-tested adapters absorb provider differences so they never leak into the agent loop.
- **Permissions you can tune — safe by default.** Three sandbox scopes (read-only / workspace-write / full-access) × three approval policies (untrusted / on-request / never), stacked allow/deny rules, and a hard directory boundary. Safety is the default; autonomy is opt-in.
- **Sessions that never forget.** Persistent session logs, `/resume`, incremental context compaction (no context collapse), prompt caching, and per-section token accounting via `/context`.
- **Knows your project.** Reads `AGENTS.md` (with `CLAUDE.md` compatibility), stacked global → project → subdirectory.
- **Extensible through open standards.** MCP tools, SKILL.md skills, lifecycle hooks, custom slash commands, and custom agents. No proprietary formats — reuse the ecosystem you already have.

## Requirements

- **Node.js** 20+ (or Bun)
- **Platform:** macOS or Linux

## Installation

```bash
npm install -g modou
```

## Quick Start

```bash
cd your-project
modou "how does authentication flow through this codebase?"
```

Then keep the conversation going with slash commands:

| Command    | Description                       |
| ---------- | --------------------------------- |
| `/help`    | List all available slash commands |
| `/model`   | Switch models mid-session         |
| `/context` | Inspect token usage by section    |
| `/compact` | Compact the session history       |
| `/resume`  | Resume a previous session         |

## How It Works

Three packages, one contract:

- **`core`** — the agent loop, the tool pipeline, permissions, and context management. Zero UI dependencies; it only emits events.
- **`tui`** — an Ink-based terminal interface. A pure consumer of the core event stream.
- **`cli`** — the executable entry point (`modou`, alias `mo`).

Everything the interface shows is an _event_; everything you do is a _command_. This single, narrow contract keeps the core UI-agnostic — headless mode, an SDK, and editor integration are all just different consumers of the same stream.

All side effects flow through a single tool pipeline — the one choke point where permissions, hooks, and audit attach. There is deliberately no second path.

## Security

- **Sandbox scopes:** read-only · workspace-write · full-access
- **Approval policies:** untrusted · on-request · never
- **Rules:** stacked allow/deny prefixes plus a built-in danger-command blacklist (e.g. `rm -rf`, force-push)
- **Path boundary:** real paths are resolved (symlinks followed, `..` expanded) before any check — no string-prefix tricks

Rules and approvals are defense-in-depth: they stop accidents and model recklessness. The true isolation boundary — an OS-level sandbox (Seatbelt / Landlock) — is planned for a future release.

## Contributing

Issues and pull requests are welcome.
