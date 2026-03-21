# claude-channel-daemon

A reliable daemon wrapper for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) Channels. Runs Claude Code CLI as a long-lived background service with automatic session management, context window rotation, and memory backup.

[中文版 README](README.zh-TW.md)

> **⚠️ Security Notice:** This daemon runs Claude Code with `acceptEdits` permission mode and a PreToolUse hook backed by a remote approval server (Telegram inline buttons). Dangerous operations (rm, git push --force, etc.) require your explicit approval via Telegram. If the approval server is unreachable, **all tool calls are denied**. Review the [Permission Architecture](#permission-architecture) section before deploying.

## Why

Claude Code's Telegram plugin requires an active CLI session — close the terminal and the bot dies. This daemon solves that by:

- Running Claude Code in the background via `node-pty`
- Automatically restarting on crashes with exponential backoff
- Rotating sessions when context usage gets too high
- Backing up memory to SQLite
- Installing as a system service (launchd / systemd)

## Quick Start

```bash
# Clone and install
git clone https://github.com/suzuke/claude-channel-daemon.git
cd claude-channel-daemon
npm install

# Interactive setup
npx tsx src/cli.ts init

# Start the daemon
npx tsx src/cli.ts start
```

## CLI Commands

```
claude-channel-daemon start    Start the daemon
claude-channel-daemon stop     Stop the daemon
claude-channel-daemon status   Show running status
claude-channel-daemon logs     Show daemon logs (-n lines, -f follow)
claude-channel-daemon install  Install as system service
claude-channel-daemon uninstall Remove system service
claude-channel-daemon init     Interactive setup wizard
```

## Architecture

```
┌─────────────────────────────────────────────┐
│              claude-channel-daemon           │
│                                             │
│  ┌─────────────────┐  ┌──────────────────┐  │
│  │ Process Manager  │  │ Context Guardian │  │
│  │ (node-pty)       │  │ (rotation)       │  │
│  └────────┬─────────┘  └────────┬─────────┘  │
│           │                      │            │
│  ┌────────┴─────────┐  ┌────────┴─────────┐  │
│  │  Memory Layer     │  │   Service        │  │
│  │  (SQLite backup)  │  │   (launchd/      │  │
│  │                   │  │    systemd)      │  │
│  └───────────────────┘  └──────────────────┘  │
│                                             │
│           ┌──────────────┐                  │
│           │  Claude Code  │                  │
│           │  CLI (PTY)    │                  │
│           │  + Telegram   │                  │
│           │    Plugin     │                  │
│           └──────────────┘                  │
└─────────────────────────────────────────────┘
```

### Process Manager

Spawns Claude Code via `node-pty` with channel mode enabled. Handles session persistence (resume via UUID), graceful shutdown (`/exit`), and automatic restarts with configurable backoff.

### Context Guardian

Monitors context window usage via Claude Code's status line JSON. Triggers session rotation when usage exceeds the configured threshold or max session age. Supports three strategies: `status_line`, `timer`, or `hybrid`.

### Memory Layer

Watches Claude's memory directory with chokidar and backs up files to SQLite for persistence across session rotations.

### Service Installer

Generates and installs system service files — launchd plist for macOS, systemd unit for Linux. Starts automatically on boot.

## Configuration

Config file: `~/.claude-channel-daemon/config.yaml`

```yaml
channel_plugin: telegram@claude-plugins-official
working_directory: /path/to/your/project

restart_policy:
  max_retries: 10
  backoff: exponential  # or linear
  reset_after: 300      # seconds of stability before resetting retry counter

context_guardian:
  threshold_percentage: 80  # rotate when context reaches this %
  max_age_hours: 4          # max session age before rotation
  strategy: hybrid          # status_line | timer | hybrid

memory:
  auto_summarize: true
  watch_memory_dir: true
  backup_to_sqlite: true

log_level: info  # debug | info | warn | error
```

## Data Directory

All state is stored in `~/.claude-channel-daemon/`:

| File | Purpose |
|------|---------|
| `config.yaml` | Main configuration |
| `daemon.pid` | Process ID (while running) |
| `session-id` | Saved UUID for session resume |
| `statusline.json` | Current context/cost status |
| `claude-settings.json` | Injected Claude Code settings |
| `memory.db` | SQLite memory backup |
| `.env` | Telegram bot token |

## Permission Architecture

Claude Code has two separate permission layers. The daemon handles both to prevent hanging in headless mode:

### Layer 1: Tool-Level Permissions

Claude Code prompts when a tool (Edit, Bash, MCP tool, etc.) is used for the first time in a session.

**Our solution: `permissions.allow` in settings file**

All standard tools and Telegram MCP tools are pre-approved. Claude Code never prompts for tool-level permissions.

```
Read, Edit, Write, Glob, Grep, Bash(*), WebFetch, WebSearch, Agent, Skill,
mcp__plugin_telegram_telegram__reply, react, edit_message
```

### Layer 2: Dangerous Operation Detection (PreToolUse Hook)

Every tool call is POSTed to the Telegram plugin's approval server (`127.0.0.1:18321/approve`).

| Operation | Behavior |
|-----------|----------|
| Safe (ls, grep, read, etc.) | Auto-approved |
| Dangerous (rm, sudo, git push, chmod, etc.) | Telegram inline button (✅ Approve / ❌ Deny) |
| Sensitive paths (.env, .claude/settings.json) | Telegram inline button |
| Hardcoded deny (rm -rf /, dd, mkfs) | Denied in settings |
| Server unreachable | Denied for safety |

The approval server runs inside the Telegram plugin (Bun HTTP on localhost:18321). It uses regex patterns to classify operations:

```typescript
const DANGEROUS_BASH = [
  /(?:rm|rmdir)\s/i,
  /(?:sudo|kill|killall|pkill)\s/i,
  /git\s+push/i,
  /git\s+reset\s+--hard/i,
  // ... more patterns
]
```

### Layer 3: Hard-Coded Path Protection (PTY Fallback)

Claude Code has **hard-coded protection** for writes to `.git/`, `.claude/`, `.vscode/`, and `.idea/` directories. This protection **cannot be overridden** by `permissions.allow` or `acceptEdits` mode — it always prompts in the terminal.

In headless mode, these prompts would block the session forever. The daemon detects them from the PTY output and forwards to Telegram:

```
PTY prompt detected ("1.Yes  2.Yes,andallow...  3.No")
  → Send Telegram message with ✅批准 / ❌拒絕 buttons
  → Wait for user response (2 min timeout → auto-deny)
  → Type "1" or "3" into PTY
```

### Why not `bypassPermissions`?

`bypassPermissions` would solve Layer 3 (it skips path protection), but it **prevents plugin loading** — including the Telegram plugin itself. This is a Claude Code bug/limitation. We use `acceptEdits` mode instead, which auto-approves standard edits while keeping plugins loaded.

### Permission Flow Summary

```
Claude wants to use a tool
    │
    ├─ permissions.allow list → tool allowed?
    │   YES → continue
    │   NO → Claude Code prompts (would hang) → solved by allow list
    │
    ├─ PreToolUse hook → POST to approval server
    │   Safe → auto-allow
    │   Dangerous → Telegram inline button → user decides
    │   Server down → deny
    │
    └─ Hard-coded path protection (.git/, .claude/, etc.)
        PTY prompt appears → forwarded to Telegram → user decides
```

## Requirements

- Node.js >= 20
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- Telegram bot token (created via [@BotFather](https://t.me/BotFather))

## License

MIT
