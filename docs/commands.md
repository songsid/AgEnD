# Commands Reference

All slash commands available in Telegram and Discord, organized by platform and mode. Commands marked with 🔒 require admin permission.

## Telegram — Fleet Topic Mode (Forum Group)

Registered via `setMyCommands` with `scope: chat` and `scope: chat_administrators` of the fleet's forum group (`group_id`), whenever that Telegram connection starts or is rebuilt. The 🔒 in the menu is generated from the command table (`src/command-table.ts`), not typed.

| Command | Description | Permission |
|---------|-------------|------------|
| `/sysinfo` | System diagnostics, including each backend CLI's version (also `/sys-info`, `/sys_info` when typed) | All |
| `/ctx` | Show agent context usage | All |
| `/usage` | Show AI subscription usage | All |
| `/compact [instructions]` | Compact agent context; the optional text steers the summary (Claude Code only — other backends compact without it and say so) | All |
| `/cancel` | Interrupt agent generation (handled, not in menu) | All |
| `/save` | Save agent session (handled, not in menu) | All |
| `/steer <message>` | Interject into the agent's *current* turn instead of queueing for idle. Not admin-gated — anyone who can talk to the agent can steer it. Only `claude-code`, `codex`, and `grok` accept a busy-pane interjection; other backends reply "not supported". | All |
| `/btw <message>` | Ask a side question without interrupting the agent's current task — delivered as a labelled `[BTW — side question]` inbound message via the same paste path as `/steer`, but framed as a question rather than new direction. Not admin-gated. `claude-code` only; every other backend replies "not supported". | All |
| `/tips` | Draw a random usage tip, posted directly in the topic/channel where you ran it (no longer routed through General). 300 tips exist (100 beginner + 100 intermediate + 100 advanced), but only the **beginner** tier is currently drawn from — intermediate/advanced are staged but not yet enabled fleet-wide. | All |
| 🔒 `/status` | Fleet table: Instance, Backend, Model, Ctx, Effort, Cost, State (State merges paused/stopped/crashed with the execution state) | Admin |
| 🔒 `/pause` | Pause an idle instance | Admin |
| 🔒 `/wake` | Wake a paused instance | Admin |
| 🔒 `/restart [full]` | Restart all instances in-process; `full` reloads the entire Fleet process and adapters, independent of version | Admin |
| 🔒 `/update` | Update AgEnD to latest | Admin |
| 🔒 `/doctor` | Run health diagnostics | Admin |
| 🔒 `/login [backend\|cancel]` | **(beta)** Remote CLI sign-in — and install — without SSH. Away from the machine, a `kiro-cli` or `claude-code` sign-in can open a one-tap temporary public link (AgEnD fetches a pinned, checksum-verified cloudflared if needed) — see [configuration](configuration.md#finishing-a-login-away-from-the-machine-public-link). One entry point: a CLI that is not installed yet is installed first (the backend's official install script in a temporary tmux window, verified on PATH), then signed in. The old `/install-cli` (`/install_cli`) still works when typed but only redirects to `/login` with a "moved" notice — it is in no menu. No arg shows a backend picker of every installed or installable backend, each labelled with what a click does; device-code backends (codex, grok) post a URL and code in the chat; the others (claude, kiro) open a browser terminal where you finish the sign-in (and can paste the code back). Sign-in covers `codex`, `grok`, `kiro` and `claude`; `opencode` and `muse` are install-only (no sign-in flow); `antigravity` is refused outright — bare `agy` is the full agent CLI with no isolated login sub-command (user decision v2.1.5, `remoteLogin: "unsupported"` in `src/login-flows.ts`). Opens a temporary tmux window (instance panes untouched), warns if auth is already valid, 10-minute timeout, `/login cancel` anytime. Credentials are per-backend shared — one login fixes every instance on that backend, and running instances restart afterward to pick up the new credential. Also on Discord (`/login backend:… cancel:…`); not on TG Classic. | Admin |
| `/collab` | Toggle bot/webhook message reception | All |
| 🔒 `/dashboard` | Show View/Settings/WebUI URLs (token-bearing URLs wrapped in a spoiler so they are not shown in the clear) | Admin |
| 🔒 `/model` | Change backend model (inline keyboard). A typed name applies directly (`/model sonnet`); with no arg the menu opens. On `claude-code`, a two-tier menu: 6 quick-select aliases, plus a "📋 更多模型…" (more models) button that fetches the live model catalog from the API (24h cache, falls back to the alias list on failure). | Admin |
| 🔒 `/effort` | Adjust AI reasoning effort (low/medium/high/xhigh/max). A typed level applies directly; with no arg the menu opens | Admin |
| 🔒 `/clear` | Full conversation reset (destructive) — asks for Confirm/Cancel before running. Sends each backend's own reset command (`/clear` for most, `/new` for grok). | Admin |
| 🔒 `/tips on\|off` | Toggle the daily auto-sent tip to the General topic | Admin |
| 🔒 `/tips advanced on` | Fleet-wide manual unlock of the advanced tips tier (independent of the per-user dismiss-count unlock). Currently has no visible effect while the beginner-only rollout stage is active — see the `/tips` row above. | Admin |
| 🔒 `/visibility [full\|summary\|hidden]` | How bot-to-bot (cross-instance) messages appear in instance topics: `full` posts the whole message (the default, as before), `summary` one line per message, `hidden` nothing. With a mode it sets the fleet default and saves it to `fleet.yaml` (`defaults.cross_instance_visibility`); with none it shows the current setting and which instances have their own. Delivery and the Mirror Topic are never affected. General topic only. See [features](features.md#bot-to-bot-message-visibility). | Admin |

## Telegram — ClassicBot (Private Chats + Groups)

Registered via `setMyCommands` with `scope: all_group_chats` and `scope: default` on every Telegram connection — including one that runs ClassicBot only and has no `group_id` (before 2.1.11 such a connection got no menu at all, #1191). Locks generated from the command table, as above.

| Command | Description | Permission |
|---------|-------------|------------|
| `/start` | Start an agent in this chat | Private chat: the user allowlist. Group: the group allowlist and a ClassicBot admin |
| 🔒 `/stop` | Stop the agent | Admin |
| 🔒 `/compact [instructions]` | Compact agent context; the optional text steers the summary (Claude Code only — other backends compact without it and say so) | Admin |
| 🔒 `/model` | Switch model | Admin |
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
| `/cancel` | All users | Interrupt generation; handled when typed, not in the menu |
| `/save <filename>` | Admin | Save session; handled when typed, not in the menu |

---

## Discord — Slash Commands

Registered globally via `client.application.commands.set()`.

| Command | Description | Permission |
|---------|-------------|------------|
| `/start` | Start an agent in this channel | All |
| 🔒 `/stop` | Stop the agent in this channel | ClassicBot admin |
| `/chat <message>` | Send a message to the agent | All |
| `/sysinfo` | System diagnostics, including each backend CLI's version | All |
| `/ctx` | Show agent context usage | All |
| `/usage` | Show AI subscription usage | All |
| `/cancel` | Interrupt agent generation | All |
| `/steer <message>` | Interject into the current turn (not admin-gated; `claude-code`/`codex`/`grok` only, others reply "not supported") | All |
| `/btw <message>` | Side question that doesn't interrupt the current task (not admin-gated; `claude-code` only, others reply "not supported") | All |
| `/tips [mode]` | Draw a random usage tip, posted in the current channel (`mode` empty); `mode: on\|off` toggles the daily auto-send; `mode: advanced on` manually unlocks the advanced tier fleet-wide (no visible effect yet — beginner-only rollout stage) | All / 🔒 for `on`\|`off`\|`advanced on` |
| 🔒 `/dashboard` | Show View/Settings/WebUI URLs (ephemeral) | Admin |
| 🔒 `/status` | Fleet table: Instance, Backend, Model, Ctx, Effort, Cost, State (State merges paused/stopped/crashed with the execution state) | Admin |
| 🔒 `/pause [instance]` | Pause an idle instance | Admin |
| 🔒 `/wake [instance]` | Wake a paused instance | Admin |
| 🔒 `/restart [mode:full]` | Restart all instances in-process; `mode:full` reloads the entire Fleet process and adapters | Admin |
| 🔒 `/update` | Update AgEnD to latest version | Admin |
| 🔒 `/doctor` | Run health diagnostics | Admin |
| 🔒 `/visibility [mode]` | Show, or set (`mode: full\|summary\|hidden`), how bot-to-bot messages appear in instance channels; saved to `fleet.yaml` | Admin |
| 🔒 `/login [backend] [cancel]` | **(beta)** Remote CLI sign-in, installing the CLI first when it is missing (sign-in: `claude-code`/`codex`/`kiro-cli`/`grok`; install only: `opencode`, `muse`; `antigravity` refused outright — no isolated login sub-command) | Admin |
| 🔒 `/compact [instructions]` | Compact agent context; the optional text steers the summary (Claude Code only — other backends compact without it and say so) | Admin |
| 🔒 `/collab` | Toggle collaboration mode | Admin |
| 🔒 `/model` | Change backend model (select menu) | Admin |
| 🔒 `/effort` | Adjust AI reasoning effort (select menu) | Admin |
| 🔒 `/save <filename>` | Save the agent's conversation | Admin |
| 🔒 `/load <filename>` | Load a saved conversation | Admin |
| 🔒 `/clear` | Full conversation reset (destructive, Confirm/Cancel required); sends `/new` on grok | Admin |

## Text Commands by Platform

Typed (non-slash-menu) text behaves differently per platform:

- **Discord fleet topics:** a typed `/xxx` never runs a command — use the `/` slash menu instead. The adapter that owns the topic posts one system note saying so and consumes the message; every other bot stays silent. A `/xxx@otherbot` suffix is ignored silently.
- **Discord ClassicBot channels:** a typed `/xxx` is ignored silently by every bot — no warning (so multi-bot groups don't all reply), no command, and it is not forwarded as `/chat` either. Slash commands (`/chat`, `/ctx`, …) are unaffected.
- **Telegram fleet topics:** a bare `/cmd` runs, but only through the adapter that owns the topic — other adapters say nothing. `/cmd@otherbot` is ignored; `/cmd@ourbot` runs.
- **Telegram ClassicBot groups:** a bare `/cmd` is ignored; only `/cmd@ourbot` runs.
- **Telegram private chats:** unchanged — a bare `/cmd` runs.

On every platform, only the topic/entry owner ever answers, so a `/cmd` typed in a multi-bot group never gets two replies.

---

## Permission Model

### Fleet Admin (`fleet.yaml` → `channel.access.allowed_users`)

Fleet-level commands — requires fleet admin:
- `/status`, `/restart`, `/update`, `/doctor`, `/visibility`, `/pause`, `/wake`, `/model`, `/effort`, `/clear`, `/login`

### ClassicBot Admin (`classicBot.yaml` → `defaults.admin_users`)

ClassicBot management commands:
- TG: `/start` (groups), `/stop`, `/raw`, `/pause` and `/wake` and `/compact` and `/save` (in a ClassicBot chat)
- DC: `/stop`, `/load`

### Context-dependent

Permission varies by platform/mode:
- `/compact` — TG Classic: ClassicBot admin. TG fleet topic: all users. DC: fleet admin in a fleet channel, fleet admin or ClassicBot admin in a ClassicBot channel.
- `/pause`, `/wake` — TG Classic: ClassicBot admin only. DC Classic: fleet admin or ClassicBot admin. Fleet topics: fleet admin.
- `/ctx` — all users (both platforms)
- `/collab` — DC: fleet admin in a fleet channel; fleet admin or ClassicBot admin in a ClassicBot channel. TG: no check in a fleet topic (anyone the access policy admits); in a ClassicBot chat it is not a command (the text goes to the agent).
- `/tips` — drawing a tip is all-users, posted wherever it was invoked; `/tips on`/`off`/`advanced on` require fleet admin. Not registered on TG Classic at all.

### All Users

No permission check:
- `/sysinfo`, `/ctx`
- `/steer`, `/btw` — deliberately not admin-gated on any platform/mode; both only change *when* (and, for `/btw`, how a reply is framed) a message a user could already send lands, so neither carries extra privilege
- TG @mention conversation
- DC `/start` (guild allowlist), `/chat`

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
| `muse` | ✅ (verified live on muse 1.3.0) | ❌ "not supported" | `/clear` |

A `/steer` or `/btw` on an unsupported backend gets an honest error instead of silently falling back to a normal queued message (which would look the same to the user but behave differently). `/btw` rides the same paste path as `/steer` but is Claude Code-only — it exists because Claude Code's *native* `/btw` opens a side-fork that never reaches the channel, so AgEnD substitutes a labelled inbound message instead.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `agend start` | Start the fleet daemon |
| `agend stop` | Stop the fleet daemon |
| `agend ls` | List instances with status (Idle/Busy/Crashed/Stopped/Paused) |
| `agend update [--alpha\|--beta\|--stable]` | Update AgEnD on the installed channel (an alpha stays on alpha, a beta on beta); `--stable` switches to the stable release |
| `agend doctor` | Run backend health diagnostics |
| `agend doctor mcp` | Fleet-wide MCP health check (IPC, config paths, duplicates, binary PATH) |
| `agend web` | Launch Web UI dashboard |
| `agend web-token rotate` | Revoke every dashboard link and browser session |
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
