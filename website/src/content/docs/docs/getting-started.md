---
title: Getting Started
description: Install AgEnD, connect a bot, and run your first agent from your phone.
---

AgEnD runs your AI coding agents as a system service and puts them in your Telegram or Discord. One bot, one agent per project, all reachable from your phone.

## Requirements

- Node.js and npm. On macOS (11 or newer) and on Linux with glibc 2.28 or newer (x64 or arm64), AgEnD installs its own Node 22 and runs on it, whatever Node runs npm. Elsewhere it needs Node 22.14+, 23.6+ or 24+.
- tmux
- To chat from Telegram or Discord: a Telegram bot token from [@BotFather](https://t.me/BotFather), or a Discord bot token. Without a bot, the fleet runs from the web dashboard alone: see the [Web Guide](/AgEnD/docs/web-guide/).
- At least one AI coding CLI, installed and logged in — see [Backends](#install-a-backend)

macOS and Linux are supported. musl Linux such as Alpine, and Linux hosts without systemd, are not: AgEnD may install there, but it is not tested or promised to work. Native Windows is not supported either: run AgEnD inside WSL, which the [Windows installation guide](/AgEnD/install-windows/) sets up for you.

## Install

```bash
curl -fsSL https://songsid.github.io/AgEnD/install.sh | bash
```

This installs Node.js 22 through nvm if you have no Node or one that is too old, installs tmux, installs `agend`, then tells you to run `agend quickstart`. When the script runs in an interactive terminal rather than through a pipe, it offers to start it right away.

On Windows, run this in PowerShell instead. It sets up WSL 2 and Ubuntu, then installs your AI backend and AgEnD inside it and connects your bot. It asks once for Administrator approval, and after the restart WSL may need, running the same line again resumes it. See the [Windows installation guide](/AgEnD/install-windows/).

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"
```

Already have Node and tmux:

```bash
npm install -g @songsid/agend
```

On WSL, the installer avoids the Windows `node.exe` on your PATH. If commands still resolve to Windows binaries, add this to `/etc/wsl.conf` and run `wsl --shutdown`:

```ini
[interop]
appendWindowsPath=false
```

## Install a backend

AgEnD drives a CLI you already use. Install one and log in before running setup.

| Backend | Install | Log in with |
|---|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude` |
| OpenAI Codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `codex` |
| Kiro CLI | `curl -fsSL https://cli.kiro.dev/install \| bash` | `kiro-cli login` |
| Antigravity CLI | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | `agy` |
| Grok Build | `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok` |
| Meta Muse Code | `mkdir -p "$HOME/.local/bin" && curl -fsSL https://api.meta.ai/muse-launcher.sh -o "$HOME/.local/bin/muse" && chmod +x "$HOME/.local/bin/muse" && MUSE_LAUNCHER_INSTALL=1 "$HOME/.local/bin/muse"` | `muse login` |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | `opencode` |

Check the one you picked before going further:

```bash
agend backend doctor claude-code
```

Once the fleet is running you can also do this from chat: `/login` in General installs a missing CLI and signs it in (Claude Code, Codex, Kiro CLI, Grok), so you don't need SSH. OpenCode and Muse are install-only there, and Antigravity is signed in on the host.

## Set up

```bash
agend quickstart
```

It runs in four steps:

1. It finds the AI coding CLI you have, and asks which one if there are several.
2. It asks for Telegram, Discord, or both. Discord is built in, so there is nothing extra to install.
3. It checks your bot token. On Telegram it then finds your group and your user ID once you send `/start` in the group. On Discord it lists the servers the bot is in, or asks for the server ID if it is in none. It waits up to 30 seconds for your message in that server or a DM to the bot, then asks you to confirm the displayed username and ID. If detection fails or you decline, enter a required 17–20-digit user ID manually. It also asks for the General channel ID (Developer Mode → Copy ID), and offers ClassicBot.
4. It asks where your projects live.

It writes `~/.agend/fleet.yaml`, with access locked to your user ID, and the bot token to `~/.agend/.env`. At the end it offers to install the fleet as a service and start it, then shows where the web dashboard is.

Step-by-step bot guides: [Telegram](/AgEnD/setup-telegram/), [Discord](/AgEnD/setup-discord/).

Run `agend quickstart` again later to add users, a second platform, or a Discord persona bot to an existing config.

To set up from your phone instead of the terminal, see [`agend setup --tunnel`](/AgEnD/docs/cli/#web-dashboard). The setup page (`agend setup`) also offers **Web only (no bot)**: no token, the first agent only, and the web dashboard for everything else.

## Start the fleet

If quickstart installed the service, the fleet is already running. Otherwise:

```bash
agend fleet start
```

To keep it running across reboots, install it as a service:

```bash
agend install
```

## Send your first message

Send a message in the **General** topic (Telegram) or the General channel (Discord). General routes it to whichever agent should handle it, and can create new agents for your projects. Each agent then gets its own topic or thread.

ClassicBot attaches an agent to any other channel. On Discord, `/start` begins one there, `/chat <message>` talks to it, and `/stop` ends it. In a Telegram group, a ClassicBot admin starts one with `/start@YourBot`. When anyone else starts one in a new server, group or private chat that is not on ClassicBot's allow lists, General is asked for approval first.

## Open the web dashboard

The fleet also serves a dashboard at `http://localhost:19280/`. It has the same chats as your bot, a **Needs you** list of everything waiting on you, and Settings, where you can add a bot, an agent, or a token.

It signs in with a one-time code, never a link that carries a password. Get one either way:

```bash
agend web          # on the machine: prints the code and opens the sign-in page
agend web --code   # only prints them
```

Or send `/web` in General (fleet admins). The bot sends you the link and the code privately, and can also offer a temporary public link for a phone that can't reach the machine. A code works once, for 5 minutes. A sign-in on the dashboard reached directly lasts 48 hours by default; one through the public link lasts 4 hours (30 minutes idle) and ends when the link closes.

The dashboard listens only on `127.0.0.1`. To open it from a phone, and for sessions and signing out, see the [Web Guide](/AgEnD/docs/web-guide/).

If nothing answers, check the fleet first:

```bash
agend health
```

## Updating

Send `/update` in General (fleet admins), or run this on the host:

```bash
agend update
```

It stays on the channel you installed from (a beta stays on beta), installs the new version, checks it, and restarts the fleet. Coming from 2.1, read [Upgrading from 2.1 to 2.2](https://github.com/songsid/AgEnD/blob/main/docs/upgrade-2.2.md) first. From 2.1.0–2.1.11, or on a host without AgEnD's built-in Node, follow its manual steps instead.

On Windows, the desktop shortcuts **AgEnD 儀表板** (the dashboard, its sign-in code filled in) and **AgEnD 重新啟動** (restart, after asking) come with the Windows installer. If you installed earlier, paste the [Windows one-liner](/AgEnD/install-windows/) again: it finds AgEnD already installed and only offers to add or update the shortcuts. Or, inside WSL, run `agend shortcuts`. After `agend update` in a WSL terminal without the shortcuts, one line says so, once; nothing is put on your desktop unless you run one of these.

## Next steps

- [Web Guide](/AgEnD/docs/web-guide/) — sign in, use it from a phone, sign out
- [Features](/AgEnD/docs/features/) — what the fleet can do
- [CLI Reference](/AgEnD/docs/cli/) — every command
- [Configuration](/AgEnD/docs/configuration/) — the `fleet.yaml` reference
