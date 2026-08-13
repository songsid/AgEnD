# Commands Reference

All slash commands available in Telegram and Discord, organized by platform and mode. Commands marked with 🔒 require admin permission.

## Telegram — Fleet Topic Mode (Forum Group)

Registered via `setMyCommands` with `scope: chat` (forum group only).

| Command | Description | Permission |
|---------|-------------|------------|
| `/sysinfo` | System diagnostics | All |
| `/ctx` | Show agent context usage | All |
| `/usage` | Show AI subscription usage | All |
| `/compact` | Compact agent context | All |
| `/cancel` | Interrupt agent generation (handled, not in menu) | All |
| `/save` | Save agent session (handled, not in menu) | All |
| `/steer <message>` | Interject into the agent's *current* turn instead of queueing for idle. Not admin-gated — anyone who can talk to the agent can steer it. Only `claude-code`, `codex`, and `grok` accept a busy-pane interjection; other backends reply "not supported". | All |
| 🔒 `/status` | Show fleet status and costs | Admin |
| 🔒 `/pause` | Pause an idle instance | Admin |
| 🔒 `/wake` | Wake a paused instance | Admin |
| 🔒 `/restart` | Graceful restart all instances | Admin |
| 🔒 `/update` | Update AgEnD to latest | Admin |
| 🔒 `/doctor` | Run health diagnostics | Admin |
| 🔒 `/collab` | Toggle bot/webhook message reception | Admin |
| 🔒 `/dashboard` | Show View/Settings/WebUI URLs | Admin |
| 🔒 `/model` | Change backend model (inline keyboard) | Admin |
| 🔒 `/effort` | Adjust AI reasoning effort (low/medium/high/xhigh/max) | Admin |
| 🔒 `/clear` | Full conversation reset (destructive) — asks for Confirm/Cancel before running. Sends each backend's own reset command (`/clear` for most, `/new` for grok); unsupported on `gemini-cli`. | Admin |

## Telegram — ClassicBot (Private Chats + Groups)

Registered via `setMyCommands` with `scope: default`.

| Command | Description | Permission |
|---------|-------------|------------|
| 🔒 `/start` | Start an agent in this chat | Admin |
| 🔒 `/stop` | Stop the agent | Admin |
| 🔒 `/compact` | Compact agent context | Admin |
| 🔒 `/model` | Switch model | Admin |
| 🔒 `/effort` | Set reasoning effort | Admin |
| 🔒 `/pause` | Pause the agent | Admin |
| 🔒 `/wake` | Wake the agent | Admin |
| 🔒 `/clear` | Full conversation reset (destructive, Confirm/Cancel required) | Admin |
| `/ctx` | Show context usage | All |
| `/steer <message>` | Interject into the current turn (not admin-gated; `claude-code`/`codex`/`grok` only) | All |

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
| `/sysinfo` | System diagnostics | All |
| `/ctx` | Show agent context usage | All |
| `/usage` | Show AI subscription usage | All |
| `/cancel` | Interrupt agent generation | All |
| `/steer <message>` | Interject into the current turn (not admin-gated; `claude-code`/`codex`/`grok` only, others reply "not supported") | All |
| 🔒 `/dashboard` | Show View/Settings/WebUI URLs (ephemeral) | Admin |
| 🔒 `/status` | Show fleet status and costs | Admin |
| 🔒 `/pause [instance]` | Pause an idle instance | Admin |
| 🔒 `/wake [instance]` | Wake a paused instance | Admin |
| 🔒 `/restart` | Graceful restart all instances | Admin |
| 🔒 `/update` | Update AgEnD to latest version | Admin |
| 🔒 `/doctor` | Run health diagnostics | Admin |
| 🔒 `/compact` | Compact agent context | Admin |
| 🔒 `/collab` | Toggle collaboration mode | Admin |
| 🔒 `/model` | Change backend model (select menu) | Admin |
| 🔒 `/effort` | Adjust AI reasoning effort (select menu) | Admin |
| 🔒 `/save <filename>` | Save the agent's conversation | Admin |
| 🔒 `/load <filename>` | Load a saved conversation | Admin |
| 🔒 `/clear` | Full conversation reset (destructive, Confirm/Cancel required); sends `/new` on grok, unsupported on `gemini-cli` | Admin |

---

## Permission Model

### Fleet Admin (`fleet.yaml` → `channel.access.allowed_users`)

Fleet-level commands — requires fleet admin:
- `/status`, `/restart`, `/update`, `/doctor`, `/collab`, `/pause`, `/wake`, `/model`, `/effort`, `/clear`

### ClassicBot Admin (`classicBot.yaml` → `defaults.admin_users`)

ClassicBot management commands:
- TG: `/start` (groups), `/stop`, `/raw`, `/clear`
- DC: `/save`, `/load`

### Context-dependent

Permission varies by platform/mode:
- `/compact` — TG Classic: admin required. DC + TG Fleet: all users.
- `/ctx` — all users (both platforms)
- `/collab` — fleet topics: fleet admin. Classic: admin.

### All Users

No permission check:
- `/sysinfo`, `/ctx`
- `/steer` — deliberately not admin-gated on any platform/mode; steering only changes *when* a message a user could already send lands, so it carries no extra privilege
- TG @mention conversation
- DC `/start`, `/stop`, `/chat`

### /steer and /clear backend support

Both commands route through a backend-name lookup rather than being universally available:

| Backend | `/steer` (busy-pane interject) | `/clear` (full reset) |
|---------|------|-------|
| `claude-code` | ✅ | `/clear` |
| `codex` | ✅ | `/clear` |
| `grok` | ✅ | `/new` |
| `kiro-cli` | ❌ "not supported" (legacy TUI swallows the paste) | `/clear` |
| `opencode` | ❌ unverified | `/clear` |
| `antigravity` | ❌ unverified | `/clear` |
| `gemini-cli` (⚠️ deprecated) | ❌ | ❌ "not supported" |

A `/steer` on an unsupported backend gets an honest error instead of silently falling back to a normal queued message (which would look the same to the user but behave differently).

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `agend start` | Start the fleet daemon |
| `agend stop` | Stop the fleet daemon |
| `agend ls` | List instances with status (Idle/Busy/Crashed/Stopped/Paused) |
| `agend update [--beta]` | Update AgEnD to latest version |
| `agend doctor` | Run backend health diagnostics |
| `agend doctor mcp` | Fleet-wide MCP health check (IPC, config paths, duplicates, binary PATH) |
| `agend web` | Launch Web UI dashboard |
| `agend export` | Export fleet config (fleet.yaml + classicBot.yaml) |
| `agend logs` | View fleet logs |

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
