<p align="center">
  <h1 align="center">AgEnD</h1>
  <p align="center">
    <strong>Run a fleet of AI coding agents from your phone.</strong>
  </p>
  <p align="center">
    <a href="https://songsid.github.io/AgEnD"><img src="https://img.shields.io/badge/Website-songsid.github.io/AgEnD-blue" alt="Website"></a>
    <a href="https://www.npmjs.com/package/@songsid/agend"><img src="https://img.shields.io/npm/v/@songsid/agend" alt="npm"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D%2022.14.0-green.svg" alt="Node.js >= 22.14.0"></a>
  </p>
</p>

AgEnD (**Agent Engineering Daemon**) turns your Telegram, Discord or browser into a command center for AI coding agents. One bot, multiple CLI backends, unlimited projects — each running as an independent session with crash recovery and zero babysitting.

<p align="center">
  <code>You → Telegram/Discord/Web → AgEnD → Fleet of AI Agents → Results back to you</code>
</p>

[繁體中文](README.zh-TW.md) · [Documentation](docs/features.md) · [CLI Reference](docs/cli.md) · [2.3 what’s new](docs/whats-new-2.3.md) · [Upgrading to 2.3](docs/upgrade-2.3.md)

---

<p align="center"><strong>Your AI agents, in the chat apps you already use.</strong></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/readme/hero-dark.webp">
    <img src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/readme/hero-light.webp" width="880" alt="The AgEnD web dashboard, with made-up demo data: a sidebar of six agents with their status, a chat with the agent Pixel that shows a table of bundle sizes, a code block, a chosen “Ship it” reply button, an attached report and a usage panel with five AI providers. Beside it, an illustration of a phone showing the same conversation, with the Discord and Telegram logos.">
  </picture>
</p>

<p align="center"><em>Every agent gets its own chat: in Telegram, in Discord, or in the built-in web dashboard. The phone is an illustration.</em></p>

## Why AgEnD?

| Without AgEnD | With AgEnD |
|---|---|
| Close the terminal, agent goes offline | Runs as a system service — survives reboots |
| One terminal = one project | One bot, unlimited projects running in parallel |
| Long-running sessions accumulate stale context | CLI auto-compact + crash recovery with context snapshots |
| No idea what your agents are doing overnight | Daily cost reports + hang detection alerts |
| Agents work in silos, can't coordinate | Peer-to-peer collaboration via MCP tools |
| Runaway costs from unattended sessions | Per-instance daily spending limits that stop the instance |

## Feature Highlights

✨ **New in 2.3:** a task board (Fleet › Tasks) that can remind you in chat, global search with Ctrl+K, an Office view of the fleet, your own domain for the public link, and a one-line Windows installer. See [What's new in 2.3](docs/whats-new-2.3.md), and [Upgrading from 2.2 to 2.3](docs/upgrade-2.3.md).

<p align="center"><img src="docs/assets/whats-new-2.3/task-board.webp" width="760" alt="The task board, with made-up demo data: the Leaderboard project with one card each in To do, In progress and Blocked; the blocked card shows its question, “Which scores count: ranked games only?”."></p>

🚀 **Fleet Management** — One bot, N projects. Each Telegram forum topic or Discord channel is an isolated agent session.

🔄 **Multi-Backend** — Claude Code, Codex, OpenCode, Kiro CLI, Antigravity CLI, Grok Build, Meta Muse Code. Switch or mix freely, or move an agent to another CLI from chat with `/backend`.

💬 **Web Chat & Dashboard** — Send `/web` and sign in with a one-time code, on this computer or from your phone through a temporary public link. Each agent's chat is the same conversation as its topic, with files, image and HTML previews, Stop, reply buttons and polls. A live **View** of every terminal, fleet pages and Settings sit alongside, and a fleet can run from the browser alone. See the [web dashboard guide](docs/web-dashboard.md).

🙋 **Needs You** — Every prompt, permission request, sign-in and stuck agent across your bots in one live list, in General and on the web. Handle it anywhere and it leaves every list.

🤝 **Agent Collaboration** — Agents discover, wake, and message each other via MCP tools. A General Topic routes tasks to the right agent using natural language.

📱 **Mobile Control** — Approve tool use, restart sessions, and manage your fleet from Telegram or Discord buttons.

🛡️ **Autonomous & Safe** — Cost guards, hang detection, model failover, and crash recovery keep your fleet running without babysitting.

⏰ **Persistent Schedules** — Cron-based tasks backed by SQLite. Survives restarts.

🎤 **Voice Messages** — Talk to your agents with Groq Whisper transcription.

📄 **HTML Chat Export** — Export any agent session as a self-contained HTML file for sharing or archiving.

🪞 **Mirror Topic** — Cross-instance visibility. Watch another agent's work in real time from a separate topic.

🛑 **Cancel Button** — Interrupt agent generation with a single tap. Inline button appears on every message; works across TG and Discord.

📬 **Delivery Status** — Each message you send gets a reaction that tracks it: on Discord 👀 received → ⏳ queued → 👀 with the agent → ✅ delivered, or ❌ if delivery failed. Telegram only accepts its own reaction set, so there it is 👀 throughout and 👎 on failure.

🎨 **Configurable Status Emoji** — Every delivery-status emoji can be changed per channel or per instance with `status_emojis`, including Discord server emoji. See [Configuration](docs/configuration.md#channeloptionsstatus_emojis-discord-and-telegram).

🔌 **Extensible** — Adapter plugins, webhook notifications, health endpoint, external session support via IPC.

👥 **Teams & Task Board** — Named groups for targeted broadcasting. Shared task board (Fleet › Tasks) for multi-step work across instances, with dependencies and comments. Turn on the chat reminders with `needs_you.task_board: true`.

📋 **Fleet Templates** — Define reusable fleet configurations. Deploy multi-instance setups with one command; supply `branch` to give each role its own git worktree.

😀 **Stickers & Persona Emoji** — Agents can send stickers on Discord and Telegram, and each agent can pick its own emoji so you can tell bots apart in a shared channel.

📊 **Subscription Usage** — `/usage` (also the dashboard and the `get_usage` tool) shows the remaining quota of your Claude, Codex, Kiro, Grok, Muse and Antigravity subscriptions, one row per subscription.

🔑 **Credential Profiles** — Run instances, or ClassicBot channels, on a second subscription of the same backend with `backend_options.<backend>.credential_profile` (kiro-cli, Codex and Claude Code today). See [Configuration](docs/configuration.md#credential-profiles-multiple-subscriptions-of-one-backend).

🌐 **Sign In From Your Phone** — `/login` (fleet admins) signs a CLI in without SSH: device-code logins such as Codex and Grok post their link and code in the chat, and a sign-in that needs a terminal gets a time-limited, token-protected browser terminal on the host. For kiro-cli and Claude Code it can also open a temporary public link through a Cloudflare Quick Tunnel after you confirm; AgEnD downloads `cloudflared` if it is missing. Turn it off with `web_terminal.tunnel.allow_public: false`. See [Configuration](docs/configuration.md#finishing-a-login-away-from-the-machine-public-link).

💤 **Auto-Pause & Wake** — With `auto_pause_after` (minutes, off by default) an idle instance is paused and wakes by itself when a message arrives. `/pause` and `/wake` do the same by hand.

🧠 **Memory Pressure Guard** — On Linux and macOS, host memory pressure slows new CLI starts and holds them while memory is critical. Status stays visible in logs, health and the dashboard; there are no chat broadcasts. A held human start, restart or wake action gets its reason.

## Use Cases

AgEnD is an AI personal assistant that lives in Discord, Telegram and your browser, running on the AI subscriptions you already have.

- **Work** — one channel per project; message from your phone, the assistant works on your machine and reports back. A General channel routes tasks, and assistants delegate to each other.
- **Everyday life** — DM your assistant to look things up, ask about a photo, or set a reminder.
- **Outward-facing contact point** — a ClassicBot in a partner or customer group answers from your docs and asks an internal assistant when it needs more.
- **Player showcase** — users have brought their assistants into friends' groups, with several bots in one channel and even a shared social feed.

See [Use Cases](docs/use-cases.md) for real examples, everyday tips and who it's for.

## Quick Start

One-liner (macOS / Linux — installs Node.js via nvm + tmux + agend, then runs quickstart):

```bash
curl -fsSL https://songsid.github.io/AgEnD/install.sh | bash
```

One-liner (Windows — in PowerShell; sets up WSL 2 + Ubuntu, your AI backend and AgEnD inside it, then your bot. It asks once for Administrator approval; after a restart, run the same line again and it resumes. See the [Windows installation guide](https://songsid.github.io/AgEnD/install-windows/)):

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"
```

Or install manually:

```bash
npm install -g @songsid/agend    # 1. Install
agend quickstart                # 2. Setup — backend, bot token, done
agend start                     # 3. Launch your fleet 🎉 (skip if quickstart installed it as a service)
```

Open Telegram or Discord, send a message to your bot, and start working from your phone. Or open the web dashboard at `http://localhost:19280/`. To sign in, run `agend web --code` on this machine, or send `/web` to your bot.

> **Discord?** `agend quickstart` supports Discord too — it's built in, no extra install needed. See [Discord setup guide](docs/features.md#discord-adapter).

## How It Works

```mermaid
graph LR
  You["You<br/>(Phone / PC)"] <-->|messages| Channel["Telegram / Discord<br/>/ Web UI"]
  Channel <-->|routing| Daemon["AgEnD Daemon"]

  subgraph Fleet
    Daemon --> General["General<br/>Dispatcher"]
    Daemon --> A["Instance A<br/>Claude Code<br/>Project X"]
    Daemon --> B["Instance B<br/>Antigravity CLI<br/>Project Y"]
    A <-.->|MCP Tools| B
    General -.->|routes tasks| A
    General -.->|routes tasks| B
  end
```

1. **You send a message** to your Telegram/Discord bot
2. Messages sent to the **General Topic** are interpreted and routed to the right agent. Messages to a specific topic go directly to that instance.
3. **Agent instances** run in isolated tmux sessions, each with its own project and CLI backend
4. **Agents collaborate** peer-to-peer via MCP tools — delegating tasks, sharing context, reporting results
5. **Results flow back** to your chat. Permission requests arrive as inline buttons.

## Supported Backends

| Backend | Install | Auth |
|---------|---------|------|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude` (OAuth) or `ANTHROPIC_API_KEY` |
| OpenAI Codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `codex` (ChatGPT login) or `OPENAI_API_KEY` |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | `opencode` (configure provider) |
| Kiro CLI | `curl -fsSL https://cli.kiro.dev/install \| bash` | `kiro-cli login` (AWS Builder ID) |
| Antigravity CLI | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | `agy` (Google Sign-In) |
| Grok Build | `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok` (x.ai OAuth device flow). Needs CLI 1.0.13 or later; run `grok update` if the server refuses an older one |
| Meta Muse Code | `mkdir -p "$HOME/.local/bin" && curl -fsSL https://api.meta.ai/muse-launcher.sh -o "$HOME/.local/bin/muse" && chmod +x "$HOME/.local/bin/muse" && MUSE_LAUNCHER_INSTALL=1 "$HOME/.local/bin/muse"` (the launcher keeps its binary beside itself, so it is saved first) | `muse login` |

**Or install from chat with `/login <backend>`** (fleet admins only), without SSH-ing into the host: when the CLI is not installed yet, `/login` runs the command above in a fleet window, finds the CLI where its installer put it, adds that directory to the fleet's PATH, and offers sign-in where supported. OpenCode and Muse are install-only; Antigravity can be installed but has no isolated remote sign-in. A bare `/login` offers the available sign-in and missing-CLI installation actions.

**Tested CLI versions (AgEnD 2.3.0).** Claude Code 2.1.308 and Grok CLI 1.0.67 were audited against AgEnD end to end. Muse 1.4.12-R6909.1 was checked isolated (echo/mock) for composer, prompt and trust, plus reconstructed empty-composer placeholder fixtures. Kiro CLI up to 2.33.0: a newer kiro-cli still starts, with a warning that it is untested. Codex 0.163.0, checked for its package, recovery and quota handling. Antigravity (agy) 1.3.6. OpenCode 1.18.34. New CLI releases are audited daily, so a newer version may already work. A new release can change its screens, though, so AgEnD only claims a version once it has been tested against it.

## Requirements

- macOS, or Linux with glibc and systemd. musl Linux such as Alpine, and Linux hosts without systemd, are not supported ([details](docs/upgrade-2.2.md#1-before-you-upgrade)).
- Node.js ^22.14.0 || ^23.6.0 || >=24
- tmux
- One of the supported AI coding CLIs (installed and authenticated)
- Telegram bot token ([@BotFather](https://t.me/BotFather)) or Discord bot token
- Groq API key (optional, for voice)

> **⚠️** All CLI backends run with `--dangerously-skip-permissions` (or equivalent). See [Security](docs/SECURITY.md).

> **Codex:** each instance resumes the conversation recorded for its own working directory, so instances on git worktrees of one repository no longer take each other's sessions. See [Codex session resume](docs/features.md#codex-session-resume).

> **WSL (Windows Subsystem for Linux):** Fully supported. The install script auto-detects WSL and avoids using Windows `node.exe` from PATH. If you encounter PATH issues, add to `/etc/wsl.conf`:
> ```ini
> [interop]
> appendWindowsPath=false
> ```
> It applies the next time this Linux starts. To restart only this one, run `wsl --terminate <distro>` in PowerShell (AgEnD in it stops too: run `agend start` once you are back in). Install with: `curl -fsSL https://songsid.github.io/AgEnD/install.sh | bash`

> **Native Windows** is not supported: the `agend` and `agend-agent` commands are POSIX `sh` launchers, and AgEnD runs its instances in tmux. On Windows, install and run AgEnD inside WSL.

## Documentation

- [Use Cases](docs/use-cases.md) — what people do with AgEnD, with real examples
- [Features](docs/features.md) — detailed feature documentation
- [CLI Reference](docs/cli.md) — all commands and options
- [Configuration](docs/configuration.md) — fleet.yaml complete reference
- [Security](docs/SECURITY.md) — trust model and hardening
- [Development Setup](docs/development.md) — working on AgEnD itself

## ClassicBot

ClassicBot lets users start AI agents in any Discord text channel using slash commands — no forum topics required. On Telegram, `/start` in a private chat or `/start@yourbot` in a group does the same.

### Setup

```bash
# 1. Run quickstart (select Discord — built in, no extra install)
agend quickstart

# 2. Start the fleet (skip if quickstart installed it as a service)
agend start
```

The quickstart sets up `fleet.yaml` and offers to configure `classicBot.yaml`. Run `agend quickstart` again to add users or guilds to existing config.

### Usage

| Command | Who | Description |
|---------|-----|-------------|
| `/start <backend>` | see below | Start an agent in the current channel |
| `/chat <message>` | anyone | Send a message to the agent |
| `/steer`, `/btw`, `/cancel`, `/ctx` | anyone | Interject into the current task, ask a side question, interrupt, show context usage |
| `/pause`, `/wake`, `/compact`, `/clear`, `/model`, `/save` | admin | Pause or wake the agent, compact or clear its context, switch model, save the conversation |
| `/effort`, `/collab` | admin | Discord only: reasoning effort, collab mode |
| `/stop`, `/load` | ClassicBot admin | Stop the agent in the current channel; load a saved conversation (`/load` is Discord only) |

"Admin" is a fleet admin or a ClassicBot admin (`admin_users`) on Discord. On Telegram, existing agents’ `/pause`, `/wake`, `/compact` and `/save` accept the owning fleet admin or a ClassicBot admin. Fleet-wide commands such as `/usage` and `/status` also work in a ClassicBot channel on Discord. Who may `/start`: on Discord, a ClassicBot admin or anyone in an explicitly allowed server; an unlisted new room can ask General for approval. On Telegram, a ClassicBot admin or explicitly allowed user can start privately; a group start requires a ClassicBot admin (`/start@yourbot`).

On Discord, `/start` turns on collab mode: @-mention the bot to talk to it. See [Use Cases](docs/use-cases.md) for examples.

### Server Whitelist

Control which Discord servers can use ClassicBot via `~/.agend/classicBot.yaml`:

```yaml
defaults:
  backend: claude-code
  allowed_guilds:              # Only these servers can /start
    - "123456789012345678"
    - "9876543210123456789"
```

- **Empty or omitted** `allowed_guilds` grants no server access to a non-admin starting a new room.
- **ClassicBot admins** bypass the lists; already registered rooms keep working. The primary fleet guild does not itself grant ClassicBot admission.
- **Explicitly allowed guilds** let non-admins start ClassicBot channels.
- **A non-admin `/start` in a new unlisted room** asks General for approval.
- **Reload** — changes are detected every 30 seconds. Launch-setting changes restart running agents; supported runtime settings update in place.

### Per-Channel Backend

Override the backend for specific channels:

```yaml
defaults:
  backend: claude-code
channels:
  "1234567890":               # Discord channel ID
    name: dev-help
    backend: kiro-cli          # Override for this channel
```

Backend fallback: channel → `defaults.backend` → `fleet.yaml` defaults → `claude-code`

### Access Lists

```yaml
defaults:
  allowed_guilds: ["123456789012345678"]   # Discord servers (empty = no grant)
  allowed_groups: ["-1001234567890"]       # Telegram groups (empty = no grant)
  allowed_users: ["123456789"]             # Telegram users who may /start in a private chat (empty = no grant)
  admin_users: ["123456789"]               # ClassicBot admins (empty = nobody)
```

Quote the ids: a Discord id is too long to survive as a YAML number. With no `admin_users`, nobody can `/stop` a ClassicBot agent and nobody can start one in a Telegram group.

### Second Subscription per Channel

A channel can run on a different login of the same backend, as a fleet instance can:

```yaml
channels:
  "1234567890":
    backend: kiro-cli
    backend_options:
      kiro-cli:
        credential_profile: work   # "" = back to the shared login
```

The channel's `backend_options` are merged over the fleet.yaml defaults'. Profiles work for kiro-cli, Codex and Claude Code; an invalid profile name keeps the agent from starting rather than running it on the wrong account, and a change restarts a running agent. Log the profile in first: see [Credential profiles](docs/configuration.md#credential-profiles-multiple-subscriptions-of-one-backend). Every other `classicBot.yaml` key is in the [Configuration reference](docs/configuration.md#classicbotyaml).

## Known Limitations

- macOS 11+ (launchd) and glibc 2.28+ Linux (systemd) are supported; on Windows, use WSL with systemd. Alpine/musl, non-systemd Linux and native Windows are unsupported. Run AgEnD inside WSL ([Windows install guide](https://songsid.github.io/AgEnD/install-windows/)). Native Windows is not supported
- Official Telegram plugin in global `enabledPlugins` causes 409 polling conflicts

## License

MIT
