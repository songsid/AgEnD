---
title: Getting Started
description: Install AgEnD, connect a bot, and run your first agent from your phone.
---

AgEnD runs your AI coding agents as a system service and puts them in your Telegram or Discord. One bot, one agent per project, all reachable from your phone.

## Requirements

- Node.js 20 or newer
- tmux
- A Telegram bot token from [@BotFather](https://t.me/BotFather), or a Discord bot token
- At least one AI coding CLI, installed and logged in — see [Backends](#install-a-backend)

macOS and Linux are supported. Windows is not; use WSL.

## Install

```bash
curl -fsSL https://songsid.github.io/AgEnD/install.sh | bash
```

This installs Node.js through nvm if you don't have it, installs tmux, installs `agend`, then runs the setup wizard.

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
| Meta Muse Code | `curl -fsSL https://api.meta.ai/muse-launcher.sh \| bash` | `muse login` |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | `opencode` |

Check the one you picked before going further:

```bash
agend backend doctor claude-code
```

Gemini CLI still works but has been deprecated since 2026-06-18. Use Antigravity CLI instead.

## Set up

```bash
agend quickstart
```

It asks for your bot token, which backend to use, and which directory the first agent works in. Discord is built in — choose it at the prompt, nothing extra to install.

Run `agend quickstart` again later to add users or servers to an existing config.

To set up from your phone instead of the terminal, see [`agend setup --tunnel`](/AgEnD/docs/cli/#web-dashboard).

## Start the fleet

```bash
agend fleet start
```

To keep it running across reboots, install it as a service:

```bash
agend install
```

## Send your first message

Open Telegram, find your bot, and send it a message. In a forum group, each topic is one agent; a message to the **General** topic is routed to whichever agent should handle it.

On Discord, `/start` begins an agent in the current channel, `/chat <message>` talks to it, and `/stop` ends it.

If nothing answers, check the fleet first:

```bash
agend health
```

## Next steps

- [Features](/AgEnD/docs/features/) — what the fleet can do
- [CLI Reference](/AgEnD/docs/cli/) — every command
- [Configuration](/AgEnD/docs/configuration/) — the `fleet.yaml` reference
