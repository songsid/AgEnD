# claude-channel-daemon

Keep your Claude Code Telegram bot alive without babysitting a terminal. This daemon wraps `claude --channels` as a background service, restarts it when it crashes, rotates sessions before context fills up, and backs up memory to SQLite.

[中文版 README](README.zh-TW.md)

> **⚠️ Heads up:** The daemon pre-approves most tools and uses a PreToolUse hook to gate dangerous operations through Telegram inline buttons. If the approval server is unreachable, all tool calls are denied. Read the [permission architecture](#permission-architecture) section before running this in production.

## Why this exists

Claude Code's Telegram plugin needs a running CLI session. Close the terminal and the bot goes offline. That's fine for testing, not for anything you'd rely on.

This daemon fixes that:

- Runs Claude Code in a pseudo-terminal (`node-pty`) in the background
- Restarts on crashes with exponential backoff (1s, 2s, 4s... up to 60s)
- Watches context window usage and kills/respawns the session before quality degrades
- Backs up memory files to SQLite so nothing is lost across restarts
- Can install as a launchd (macOS) or systemd (Linux) service

## Quick start

```bash
git clone https://github.com/suzuke/claude-channel-daemon.git
cd claude-channel-daemon
npm install && npm link

# Interactive setup (bot token, working directory, system service)
ccd init

# Start
ccd start
```

After `npm link`, you get the `ccd` command globally.

## Commands

```
ccd start       Start the daemon
ccd stop        Stop it
ccd status      Check if it's running
ccd logs        Show logs (-n 50, -f to follow)
ccd install     Install as system service
ccd uninstall   Remove the service
ccd init        Interactive setup
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

**Process Manager** — Opens a PTY, runs `claude --channels plugin:telegram@...`. If it dies, waits and restarts. Captures the session UUID so it can `--resume` after a crash. Sends `/exit` for clean shutdowns.

**Context Guardian** — Reads Claude Code's status line JSON (which the daemon injects via a custom statusline script). When `context_window.used_percentage` crosses the threshold (default 40%), it kills and respawns the session. Also gets `rate_limits` and `cost` for free. No API calls spent on monitoring.

**Memory Layer** — Uses chokidar to watch `~/.claude/projects/.../memory/`. When a memory file changes, it copies the content to SQLite with a timestamp. After a session restart, Claude Code reads the memory directory on its own.

**Service Installer** — Writes a launchd plist or systemd unit file and tells you how to enable it.

## Configuration

Config lives at `~/.claude-channel-daemon/config.yaml`:

```yaml
channel_plugin: telegram@claude-plugins-official
working_directory: /path/to/your/project

restart_policy:
  max_retries: 10
  backoff: exponential  # or linear
  reset_after: 300      # reset retry counter after 5 min of uptime

context_guardian:
  threshold_percentage: 40  # kill and respawn at this %
  max_age_hours: 4          # force rotation after this long
  strategy: hybrid          # status_line | timer | hybrid

memory:
  auto_summarize: true
  watch_memory_dir: true
  backup_to_sqlite: true

log_level: info
```

## Data directory

Everything lives in `~/.claude-channel-daemon/`:

| File | What it does |
|------|-------------|
| `config.yaml` | Main config |
| `daemon.pid` | PID file (exists while running) |
| `daemon.log` | Log output (also goes to stdout) |
| `session-id` | Saved UUID for `--resume` |
| `statusline.json` | Latest status line data from Claude Code |
| `claude-settings.json` | Settings injected into the Claude session |
| `statusline.sh` | Shell script that tees status line JSON |
| `memory.db` | SQLite backup of memory files |

## Permission architecture

Claude Code has two independent permission systems. If a headless daemon doesn't handle both, it hangs. Here's what we learned the hard way.

### Tool-level permissions

Claude Code prompts the first time you use Edit, Bash, or any MCP tool in a session. In a terminal you'd click "allow." In a daemon, nobody's clicking.

We pre-approve everything in `claude-settings.json`:

```
Read, Edit, Write, Glob, Grep, Bash(*), WebFetch, WebSearch, Agent, Skill,
mcp__plugin_telegram_telegram__reply, react, edit_message
```

This eliminates all tool-level prompts.

### Dangerous operation gating (PreToolUse hook)

Every tool call goes through a PreToolUse hook that POSTs to the Telegram plugin's built-in HTTP server (`127.0.0.1:18321/approve`).

The server checks if the operation looks dangerous:

| What | Result |
|------|--------|
| `ls`, `grep`, file reads | Auto-approved, no prompt |
| `rm`, `sudo`, `git push`, `chmod` | Sends you a Telegram message with ✅/❌ buttons |
| Edits to `.env`, `.claude/settings.json` | Same, buttons |
| `rm -rf /`, `dd`, `mkfs` | Hard-denied in config, never reaches the server |
| Server unreachable | Denied (fail-closed) |

The danger patterns are regex-based:

```typescript
const DANGEROUS_BASH = [
  /(?:rm|rmdir)\s/i,
  /(?:sudo|kill|killall|pkill)\s/i,
  /git\s+push/i,
  /git\s+reset\s+--hard/i,
  // ...
]
```

### Hard-coded path protection (the annoying one)

Claude Code has built-in protection for writes to `.git/`, `.claude/`, `.vscode/`, and `.idea/`. Even with `acceptEdits` mode and a hook returning "allow," it still pops a confirmation prompt in the terminal.

In a daemon, that prompt blocks forever. So we detect it from the PTY output (it shows "1.Yes 2.Yes,andallow... 3.No") and forward it to Telegram as an inline button message. You tap approve or deny, the daemon types "1" or "3" into the PTY. Two-minute timeout, auto-denies if you don't respond.

### Why not just use `bypassPermissions`?

We tried. It prevents plugin loading entirely, including the Telegram plugin. The bot can't receive messages at all. This appears to be a Claude Code bug — the docs say bypass only skips prompts, but in practice it also blocks MCP server startup. So we use `acceptEdits` mode instead and handle the remaining edge cases with PTY detection.

### How it all fits together

```
Claude wants to use a tool
    │
    ├─ permissions.allow → tool in the list? → yes → proceed
    │
    ├─ PreToolUse hook → POST to approval server
    │   safe op → auto-allow
    │   dangerous op → Telegram button → you decide
    │   server down → deny
    │
    └─ hard-coded path protection
        PTY prompt detected → forwarded to Telegram → you decide
```

## Requirements

- Node.js >= 20
- Claude Code CLI
- Telegram bot token ([@BotFather](https://t.me/BotFather))

## Known issues

- Don't run inside cmux (its `--settings` injection conflicts with ours)
- `bypassPermissions` mode breaks plugin loading (Claude Code bug)
- Only tested on macOS

## License

MIT
