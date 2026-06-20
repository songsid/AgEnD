# Commands Reference

All slash commands available in Telegram and Discord, organized by platform and mode. Commands marked with 🔒 require admin permission.

## Telegram — Fleet Topic Mode (Forum Group)

Registered via `setMyCommands` with `scope: chat` (forum group only).

| Command | Description | Permission |
|---------|-------------|------------|
| `/status` | Show fleet status and costs | All |
| `/sysinfo` | System diagnostics | All |
| `/ctx` | Show agent context usage | All |
| `/compact` | Compact agent context | All |
| 🔒 `/restart` | Graceful restart all instances | Admin |
| 🔒 `/update` | Update AgEnD to latest | Admin |
| 🔒 `/doctor` | Run health diagnostics | Admin |
| 🔒 `/collab` | Toggle bot/webhook message reception | Admin |

## Telegram — ClassicBot (Private Chats + Groups)

Registered via `setMyCommands` with `scope: default`.

| Command | Description | Permission |
|---------|-------------|------------|
| 🔒 `/start` | Start an agent in this chat | Admin |
| 🔒 `/stop` | Stop the agent | Admin |
| 🔒 `/compact` | Compact agent context | Admin |

### Telegram ClassicBot — unregistered commands

These are handled but not shown in the bot menu:

| Command | Permission | Notes |
|---------|------------|-------|
| `@bot /raw <text>` | Admin | Send raw text directly to CLI |
| `@bot <message>` | All users | Normal conversation trigger via @mention |

---

## Discord — Slash Commands

Registered globally via `client.application.commands.set()`.

| Command | Description | Permission |
|---------|-------------|------------|
| `/start` | Start an agent in this channel | All |
| `/stop` | Stop the agent in this channel | All |
| `/chat <message>` | Send a message to the agent | All |
| `/status` | Show fleet status and costs | All |
| `/sysinfo` | System diagnostics | All |
| `/ctx` | Show agent context usage | All |
| 🔒 `/restart` | Graceful restart all instances | Admin |
| 🔒 `/update` | Update AgEnD to latest version | Admin |
| 🔒 `/doctor` | Run health diagnostics | Admin |
| 🔒 `/compact` | Compact agent context | Admin |
| 🔒 `/collab` | Toggle collaboration mode | Admin |
| 🔒 `/save <filename>` | Save the agent's conversation | Admin |
| 🔒 `/load <filename>` | Load a saved conversation | Admin |

---

## Permission Model

### Admin (allowed_users)

Fleet-level admin commands — checked against `fleet.yaml` → `channel.access.allowed_users`:
- `/restart`, `/update`, `/doctor`, `/collab`

### Admin (admin_users)

ClassicBot management commands — checked against `classicBot.yaml` → `defaults.admin_users`:
- TG: `/start` (groups), `/stop`, `/compact`, `/raw`
- DC: `/compact`, `/save`, `/load`, `/collab`

### All Users

No permission check:
- `/status`, `/sysinfo`, `/ctx`
- TG @mention conversation
- DC `/start`, `/stop`, `/chat`

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
