# claude-channel-daemon

Fleet manager for Claude Code — run multiple Claude sessions behind a single Telegram bot, each mapped to a Forum Topic. Built-in approval system, voice transcription, auto context rotation, and crash recovery.

> **⚠️** The daemon pre-approves most tools. Dangerous Bash commands (rm, sudo, git push...) are forwarded to Telegram for manual approval via inline buttons. If the approval server is unreachable, dangerous commands are denied. See [Permission Architecture](#permission-architecture).

## Why this exists

Claude Code's official Telegram plugin gives you 1 bot = 1 session. Close the terminal and it goes offline.

This daemon fixes that:

- **Fleet mode** — 1 Telegram bot, N Forum Topics = N independent Claude sessions
- **tmux-based** — Claude runs in tmux windows, survives daemon crashes
- **Auto context rotation** — sends `/compact` at 40%, restarts fresh if needed
- **Voice messages** — Telegram voice → Groq Whisper → text to Claude
- **Approval system** — dangerous Bash commands get Telegram inline buttons
- **Auto topic binding** — create a Telegram topic, pick a project directory, done
- **System service** — install as launchd (macOS) or systemd (Linux)

## Quick start

```bash
git clone https://github.com/suzuke/claude-channel-daemon.git
cd claude-channel-daemon
npm install && npm link

# Prerequisites: claude CLI + tmux
brew install tmux  # macOS

# Interactive setup
ccd init

# Start the fleet
ccd fleet start
```

## Commands

```
ccd init                  Interactive setup wizard
ccd fleet start           Start all instances
ccd fleet stop            Stop all instances
ccd fleet status          Show instance status
ccd fleet logs <name>     Show instance logs
ccd fleet start <name>    Start specific instance
ccd fleet stop <name>     Stop specific instance
ccd topic list            List topic bindings
ccd topic bind <n> <tid>  Bind instance to topic
ccd topic unbind <n>      Unbind instance from topic
ccd access lock <n>       Lock instance access
ccd access unlock <n>     Unlock instance access
ccd access pair <n> <uid> Generate pairing code
ccd install               Install as system service
ccd uninstall             Remove system service
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Fleet Manager                         │
│                                                          │
│  Shared TelegramAdapter (1 bot, Grammy long-polling)     │
│         │                                                │
│    threadId routing table: #277→proj-a, #672→proj-b     │
│         │                                                │
│  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐     │
│  │  Daemon A    │  │  Daemon B    │  │  Daemon C    │     │
│  │  IPC Server  │  │  IPC Server  │  │  IPC Server  │     │
│  │  Approval    │  │  Approval    │  │  Approval    │     │
│  │  Context     │  │  Context     │  │  Context     │     │
│  │  Guardian    │  │  Guardian    │  │  Guardian    │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │            │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐     │
│  │ tmux window   │  │ tmux window   │  │ tmux window   │     │
│  │ claude        │  │ claude        │  │ claude        │     │
│  │ + MCP server  │  │ + MCP server  │  │ + MCP server  │     │
│  └───────────────┘  └───────────────┘  └───────────────┘     │
└──────────────────────────────────────────────────────────┘
```

**Fleet Manager** — Owns the shared Telegram adapter. Routes inbound messages by `message_thread_id` to the correct daemon instance via IPC. Handles topic auto-create, auto-bind (directory browser), and auto-unbind (topic deletion detection).

**Daemon** — Per-instance orchestrator. Manages a tmux window running Claude Code with `--dangerously-load-development-channels server:ccd-channel`. Runs an approval server, context guardian, and transcript monitor.

**MCP Channel Server** — Runs as Claude's child process. Communicates with the daemon via Unix socket IPC. Declares `claude/channel` capability and pushes inbound messages via `notifications/claude/channel`. Auto-reconnects on IPC disconnect.

**Context Guardian** — Watches Claude's status line JSON. At 40% context usage, sends `/compact`. If compact doesn't bring it below threshold, kills the window and starts a fresh session.

## Configuration

Fleet config at `~/.claude-channel-daemon/fleet.yaml`:

```yaml
project_roots:
  - ~/Projects

channel:
  type: telegram
  mode: topic           # topic (recommended) or dm
  bot_token_env: CCD_BOT_TOKEN
  group_id: -100xxxxxxxxxx
  access:
    mode: locked         # locked or pairing
    allowed_users:
      - 123456789        # your Telegram user ID

defaults:
  context_guardian:
    threshold_percentage: 40
    max_age_hours: 4
  log_level: info

instances:
  my-project:
    working_directory: /path/to/project
    topic_id: 277
```

Bot token in `~/.claude-channel-daemon/.env`:
```
CCD_BOT_TOKEN=123456789:AAH...
GROQ_API_KEY=gsk_...          # optional, for voice transcription
```

## Permission architecture

### Tool permissions

All tools are pre-approved in per-instance `claude-settings.json`:
```
Read, Edit, Write, Glob, Grep, Bash(*), WebFetch, WebSearch, Agent, Skill,
mcp__ccd-channel__reply, react, edit_message, download_attachment
```

### Dangerous operation gating

A PreToolUse hook (matcher: `"Bash"`) forwards Bash commands to the approval server. The server checks against danger patterns:

| Command | Result |
|---------|--------|
| `ls`, `cat`, `npm install` | Auto-approved |
| `rm`, `mv`, `sudo`, `kill`, `git push/reset/clean` | Telegram approval buttons |
| `rm -rf /`, `dd`, `mkfs` | Hard-denied in settings |
| Approval server unreachable | Denied (fail-closed) |

### Flow

```
Claude calls Bash tool
  → PreToolUse hook fires
  → curl POST to approval server (127.0.0.1:PORT)
  → safe? → allow
  → dangerous? → IPC → fleet manager → Telegram inline buttons → you decide
  → server down? → deny
```

## Data directory

`~/.claude-channel-daemon/`:

| Path | Purpose |
|------|---------|
| `fleet.yaml` | Fleet configuration |
| `.env` | Bot token + API keys |
| `daemon.log` | Fleet log (JSON) |
| `instances/<name>/` | Per-instance data |
| `instances/<name>/session-id` | Saved session UUID for `--resume` |
| `instances/<name>/statusline.json` | Latest status line from Claude |
| `instances/<name>/channel.sock` | IPC Unix socket |
| `instances/<name>/transcript-offset` | Byte offset for transcript monitor |

## Requirements

- Node.js >= 20
- tmux
- Claude Code CLI
- Telegram bot token ([@BotFather](https://t.me/BotFather))
- Groq API key (optional, for voice transcription)

## Known issues

- Official telegram plugin in global `enabledPlugins` causes 409 polling conflicts (daemon retries with backoff)
- `--settings` override of `enabledPlugins` may not work — investigating
- Only tested on macOS

## License

MIT
