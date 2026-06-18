# Commands Reference

All slash commands available in Telegram and Discord, organized by platform and mode.

## Telegram — Fleet Topic Mode (Forum Group)

Registered via `setMyCommands` with `scope: chat` (forum group only).

| Command | Description | Permission | Handler |
|---------|-------------|------------|---------|
| `/status` | Show fleet status and costs | All (within fleet access) | Markdown table with instance/backend/ctx/cost/status |
| `/restart` | Graceful restart all instances | Admin (allowed_users) | SIGUSR2 graceful restart |
| `/sysinfo` | System diagnostics | All (within fleet access) | Markdown table with uptime/memory/heap + instance table |
| `/compact` | Compact agent context | All (within fleet access) | Sends Escape + /compact to instance tmux pane |
| `/collab` | Toggle bot/webhook message reception | All (within fleet access) | Per-instance, in-memory toggle |
| `/update` | Update AgEnD to latest | Admin (allowed_users) | Detached `agend update` (auto-detects beta) |
| `/doctor` | Run health diagnostics | Admin (allowed_users) | Executes `agend backend doctor` |

## Telegram — ClassicBot (Private Chats + Groups)

Registered via `setMyCommands` with `scope: default`.

| Command | Description | Permission | Notes |
|---------|-------------|------------|-------|
| `/start` | Start an agent in this chat | Private: allowed_users. Group: admin_users | Creates classic instance |
| `/stop` | Stop the agent | admin_users | Stops and unregisters instance |
| `/compact` | Compact agent context | admin_users | Sends /compact to tmux pane |
| `/chat` | Talk to the agent | — | Not implemented for TG classic (use @mention instead) |

### Telegram ClassicBot — unregistered commands

These are handled but not shown in the bot menu:

| Command | Permission | Notes |
|---------|------------|-------|
| `@bot /raw <text>` | admin_users | Send raw text directly to CLI (bypass /chat wrapper) |
| `@bot <message>` | All users | Normal conversation trigger via @mention |

---

## Discord — Slash Commands

Registered globally via `client.application.commands.set()`.

| Command | Description | Permission | Notes |
|---------|-------------|------------|-------|
| `/start` | Start an agent in this channel | All users | [ClassicBot] Creates classic instance |
| `/stop` | Stop the agent in this channel | All users | [ClassicBot] |
| `/chat <message>` | Send a message to the agent | All users | [ClassicBot] Required param: message |
| `/compact` | Compact the agent's context window | admin_users | [ClassicBot] |
| `/save <filename>` | Save the agent's conversation | admin_users | [ClassicBot] Optional: --force |
| `/load <filename>` | Load a saved conversation | admin_users | [ClassicBot] |
| `/ctx` | Show agent context usage | All users | [ClassicBot/Fleet] Shows % used + backend |
| `/collab` | Toggle collaboration mode | admin_users / All | [ClassicBot] @mention trigger. [Fleet] bot/webhook reception. DC /start auto-enables collab. |
| `/status` | Show fleet status and costs | All (fleet access) | [Fleet] Markdown table |
| `/sysinfo` | System diagnostics | All (fleet access) | [Fleet] Uptime/memory/instances |
| `/restart` | Graceful restart all instances | Admin (allowed_users) | [Fleet] SIGUSR2 |
| `/compact` | Compact agent context | All (fleet access) | [Fleet/ClassicBot] Sends /compact to tmux |
| `/update` | Update AgEnD to latest version | admin_users | [Fleet] Detached `agend update` (auto-detects beta) |
| `/doctor` | Run health diagnostics | admin_users | [Fleet] Executes `agend backend doctor` |

---

## Permission Model

### Admin (allowed_users in fleet.yaml)

Used for fleet-level commands in the **forum group**:
- `/update`, `/doctor`
- Checked against `fleet.yaml` → `channel.access.allowed_users`

### Admin (admin_users in classicBot.yaml)

Used for ClassicBot management commands:
- TG: `/start` (groups), `/stop`, `/raw`
- DC: `/compact`, `/save`, `/load`, `/collab`
- Checked against `classicBot.yaml` → `defaults.admin_users`

### All Users

No permission check:
- `/status`, `/sysinfo`, `/ctx`
- TG @mention conversation
- DC `/start`, `/stop`, `/chat`

---

## Hidden / Internal Commands

These are not registered as slash commands but can be typed:

| Command | Platform | Description |
|---------|----------|-------------|
| `/compact` | TG (via @mention /raw) | Compact context window |
| `/chat save <file>` | TG (via @mention /raw) | Save session |
| `/chat load <file>` | TG (via @mention /raw) | Load session |

---

## Command Flow

```
User sends /command
  → Telegram/Discord adapter emits event
  → Fleet Manager routes to handler:
     - Forum group → topic-commands.ts (handleGeneralCommand)
     - Discord slash → fleet-manager.ts (slash_command handler)
     - TG classic → fleet-manager.ts (isTelegramClassic block)
  → Handler executes + responds
```
