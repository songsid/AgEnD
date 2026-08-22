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
| `/btw <message>` | Ask a side question without interrupting the agent's current task — delivered as a labelled `[BTW — side question]` inbound message via the same paste path as `/steer`, but framed as a question rather than new direction. Not admin-gated. `claude-code` only; every other backend replies "not supported". | All |
| `/tips` | Draw a random usage tip, posted directly in the topic/channel where you ran it (no longer routed through General). 300 tips exist (100 beginner + 100 intermediate + 100 advanced), but only the **beginner** tier is currently drawn from — intermediate/advanced are staged but not yet enabled fleet-wide. | All |
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
| 🔒 `/tips on\|off` | Toggle the daily auto-sent tip to the General topic | Admin |
| 🔒 `/tips advanced on` | Fleet-wide manual unlock of the advanced tips tier (independent of the per-user dismiss-count unlock). Currently has no visible effect while the beginner-only rollout stage is active — see the `/tips` row above. | Admin |

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
| `/btw <message>` | Side question that doesn't interrupt the current task (not admin-gated; `claude-code` only) | All |

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
| `/btw <message>` | Side question that doesn't interrupt the current task (not admin-gated; `claude-code` only, others reply "not supported") | All |
| `/tips [mode]` | Draw a random usage tip, posted in the current channel (`mode` empty); `mode: on\|off` toggles the daily auto-send; `mode: advanced on` manually unlocks the advanced tier fleet-wide (no visible effect yet — beginner-only rollout stage) | All / 🔒 for `on`\|`off`\|`advanced on` |
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
- `/tips` — drawing a tip is all-users, posted wherever it was invoked; `/tips on`/`off`/`advanced on` require fleet admin. Not registered on TG Classic at all.

### All Users

No permission check:
- `/sysinfo`, `/ctx`
- `/steer`, `/btw` — deliberately not admin-gated on any platform/mode; both only change *when* (and, for `/btw`, how a reply is framed) a message a user could already send lands, so neither carries extra privilege
- TG @mention conversation
- DC `/start`, `/stop`, `/chat`

### /steer, /btw, and /clear backend support

All three commands route through a backend-name lookup rather than being universally available:

| Backend | `/steer` (busy-pane interject) | `/btw` (side question) | `/clear` (full reset) |
|---------|------|------|-------|
| `claude-code` | ✅ | ✅ | `/clear` |
| `codex` | ✅ | ❌ "not supported" | `/clear` |
| `grok` | ✅ | ❌ "not supported" | `/new` |
| `kiro-cli` | ❌ "not supported" (legacy TUI swallows the paste) | ❌ "not supported" | `/clear` |
| `opencode` | ❌ unverified | ❌ "not supported" | `/clear` |
| `antigravity` | ❌ unverified | ❌ "not supported" | `/clear` |
| `gemini-cli` (⚠️ deprecated) | ❌ | ❌ "not supported" | ❌ "not supported" |

A `/steer` or `/btw` on an unsupported backend gets an honest error instead of silently falling back to a normal queued message (which would look the same to the user but behave differently). `/btw` rides the same paste path as `/steer` but is Claude Code-only — it exists because Claude Code's *native* `/btw` opens a side-fork that never reaches the channel, so AgEnD substitutes a labelled inbound message instead.

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
