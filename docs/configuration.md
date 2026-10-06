# Configuration Reference

Complete reference for all AgEnD configuration files.

## fleet.yaml

Located at `~/.agend/fleet.yaml`. The primary configuration file for the fleet.

### Top-level fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `channel` | object | no | — | Single channel config (legacy, use `channels[]` for multi-channel) |
| `channels` | ChannelConfig[] | no | — | Multi-channel config array |
| `project_roots` | string[] | no | — | Allowed directories for instance creation |
| `defaults` | object | no | `{}` | Shared defaults applied to all instances |
| `instances` | object | **yes** | — | Per-instance configuration (keyed by instance name) |
| `teams` | object | no | — | Named groups for targeted broadcasting |
| `templates` | object | no | — | Reusable fleet deployment templates |
| `profiles` | object | no | — | Reusable backend/model presets |
| `health_port` | number | no | `19280` | HTTP health endpoint port |
| `fleet_label` | string | no | host name | How this fleet names itself in `/login`: appended to the Discord slash command description and shown under each backend picker (`🖥 Fleet: …`). Every AgEnD bot in a guild registers its own `/login`, and each one controls only the fleet that runs it — the label tells them apart. Default: the machine's host name, plus the AgEnD home's directory name when it is not `~/.agend` |
| `web` | object | no | — | Web UI feature toggles — `web.usage_panel: false` hides the AI subscription usage panel on /view and disables `/api/ai-usage` (default `true`); `web.allowed_hosts: [name, …]` adds `Host` names the dashboard answers to when reached through a reverse proxy or port forward (default: `localhost`, `127.0.0.1`, `[::1]` and `hostname`; any other `Host` gets 403 — this is what stops DNS rebinding; the `/login` browser terminal's listener uses the same list) |
| `web_terminal` | object | no | — | The browser terminal behind `/login` (sign-in and install): `enabled` (default `true`), `bind` (default `127.0.0.1`), `ttl_minutes` (1–20, default 10), and `tunnel` — a public link for `/login`, offered at each login unless `allow_public: false`, see [Finishing a /login away from the machine](#finishing-a-login-away-from-the-machine-public-link) |

---


### Several fleets in one Discord guild

Each AgEnD bot registers its own `/login`, and each one controls only the fleet
that runs that bot. Discord lists them side by side, so the description of each ends with its fleet's
label (`fleet_label`, default the host name), and every backend picker says `🖥 Fleet: <label>`.
Pick the command whose label names the fleet you want to change.

### Finishing a /login away from the machine (public link)

By default a `/login` terminal link only works on this machine (SSH forwarding, tailscale, a proxy you run).
For a phone that cannot reach it, a `kiro-cli` or `claude-code` login can open a temporary **public https link** through a
Cloudflare Quick Tunnel. Nothing needs setting up: the `/login kiro` (or `/login claude`) confirmation shows three buttons —
**I understand (temporary public link)**, **I understand (local network)**, **Cancel** — and pressing the first one is the
consent, once per login; a link is never kept or reused. This works the same on Discord and Telegram.

**cloudflared.** A `cloudflared` on the fleet's `PATH` is used if there is one. Otherwise, the first time the public link is
chosen, AgEnD downloads Cloudflare's official build into its own folder (`~/.agend/bin/cloudflared`, no sudo, nothing
installed system-wide) and says so in the chat. The version is pinned in AgEnD and the download is checked against a
SHA256 pinned with it; a file that does not match is deleted and nothing runs. The installed copy is checked again before
every use. AgEnD only installs into, and only trusts, a folder that is yours alone: if `~/.agend` (or its `bin`) is
writable by another user, or `bin` is a symlink, it refuses and says so. Linux (x86-64, arm64, arm, x86) and macOS
(Intel, Apple silicon) are covered; elsewhere, install cloudflared yourself. If it cannot be obtained (offline, blocked, `HTTPS_PROXY` is honoured), the login says why and opens nothing —
choose **I understand (local network)** instead.

To switch public links off for this host (no button, nothing ever downloaded):

```yaml
web_terminal:
  tunnel:
    allow_public: false     # default: unset — offered, and every login asks first
    # provider: cloudflared # the only provider
    # protocol: http2       # http2 (default) | quic | auto — see below
```

What it does and does not do:

- The tunnel fronts **only that login's terminal** (a listener of its own), never the dashboard. The terminal page
  alone grants nothing: you still need the one-time **access token**.
- The public link and the token are sent to **you, as two private messages** (Discord/Telegram DM) — never in the channel,
  which gets one status line. If either private message cannot be delivered (for example you never opened a chat with
  the bot), the login is closed instead; there is no "post it in the channel" fallback.
- It **fails closed**: if the tunnel cannot start, dies, or the login ends in any way (done, cancelled, timeout, fleet
  shutdown), the tunnel is stopped before the next login can start. A tunnel that cannot be confirmed stopped is
  announced in the chat with its pid and blocks further tunnels until it is dealt with.
- **Cloudflare carries the traffic.** A Quick Tunnel terminates TLS at Cloudflare's edge, so Cloudflare can see the
  page, the access token and everything typed or shown in that terminal. The consent text says so; if that is not
  acceptable for a login, use **I understand (local network)**.
- The tunnel's public name is never written to the log or the audit trail. Treat the link like the token's other half:
  do not forward or bookmark it.
- Only flows that need their terminal to finish may use it — `kiro-cli` and `claude-code` (`tunnelOk` in
  `src/login-flows.ts`). Device-code logins (codex, grok) post their URL and code in the chat and never need it.

`protocol`: cloudflared defaults to QUIC (UDP 7844), which many corporate networks and VMs block; cloudflared then
spends a long time failing over or never connects. AgEnD therefore passes `--protocol http2` (TCP to Cloudflare's edge on port 7844 — the same port number as QUIC's UDP,
which networks that drop the UDP usually still allow, but a strict firewall can close it too) unless you set
`quic` or `auto` (cloudflared decides). The same default applies to `agend setup --tunnel`. The readiness check also
resolves the tunnel's name through Cloudflare's public resolvers (1.1.1.1 / 1.0.0.1) and connects to that address with the
real host name as SNI, falling back to the system resolver: a brand-new `trycloudflare.com` name can take a minute to
resolve through a corporate DNS forwarder. The only thing that leaves the machine for this is one DNS query for the
tunnel's random host name. Startup is allowed up to a minute.

### channels[]

Each entry configures a platform adapter (Telegram or Discord).

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | multi-channel | type value | Unique identifier for this channel (e.g. "telegram", "discord") |
| `type` | string | **yes** | — | Platform type: `"telegram"` or `"discord"` |
| `mode` | string | **yes** | — | Must be `"topic"` |
| `bot_token_env` | string | **yes** | — | Environment variable name containing the bot token |
| `group_id` | number \| string | no | — | Telegram forum group ID or Discord guild ID |
| `access` | AccessConfig | **yes** | — | Access control settings (see below) |
| `options` | object | no | — | Platform-specific options (e.g. `general_channel_id` for Discord) |
| `telegram_api_root` | string | no | `"https://api.telegram.org"` | Override Telegram Bot API URL |
| `mirror_topic_id` | number \| string | no | — | Topic ID for cross-instance message mirroring |

#### channel.access

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `"locked"` \| `"pairing"` \| `"open"` | `"locked"` | `locked` = whitelist only. `pairing` = self-register via /pair. `open` = all users + bots allowed (bot messages reach fleet topics directly) |
| `allowed_users` | (number\|string)[] | `[]` | Whitelisted user IDs |
| `max_pending_codes` | number | `3` | Max simultaneous pairing codes |
| `code_expiry_minutes` | number | `10` | Pairing code TTL |

#### channel.options (Discord)

| Field | Type | Description |
|-------|------|-------------|
| `general_channel_id` | string | Discord channel ID for the General instance |

#### channel.options (Telegram)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `topic_probe` | `"on-demand"` \| `"periodic"` | `"on-demand"` | `on-demand`: a topic is only checked after a real delivery reports it missing (no scheduled send+delete, no notifications). `periodic`: also probe every bound topic on the 5-minute scan, which posts and deletes a blank message in each topic. |
| `sticker_sets` | string[] | — | The sticker sets `list_stickers` shows when an agent names none (each the `<name>` in `t.me/addstickers/<name>`; up to 10 are used). Telegram only: Discord lists the channel's server's stickers. |

#### channel.options.status_emojis (Discord and Telegram)

The delivery-status emojis this channel's bots stamp on inbound messages. Every key is optional; an unset key keeps the built-in value.

| Key | Built-in (Discord) | Built-in (Telegram) | When |
|-----|--------------------|---------------------|------|
| `received` | 👀 | 👀 | the fleet routed the message to an instance |
| `queued` | ⏳ | 👀 | waiting (instance busy, rate-limited) |
| `processing` | 👀 | 👀 | the agent has the message |
| `delivered` | ✅ | 👀 | the agent started on it |
| `failed` | ❌ | 👎 | delivery failed |
| `progress_prefix` | 👀 / ⏳ | 👀 / ⏳ | leads the "處理中…" progress message |
| `photo` | 📸 | 👌 | a ClassicBot saved an inbound photo |
| `attachment` | 📎 | 👍 | a ClassicBot saved an inbound file |

```yaml
channels:
  - type: discord
    options:
      status_emojis:
        received: "<:inbox:123456789012345678>"   # server custom emoji; <a:name:id> and name:id also work
        delivered: "<:done:123456789012345679>"
```

- **Discord** takes any emoji, including server custom emoji.
- **Telegram** takes only its fixed reaction set and no custom emoji. A value outside the set logs a warning once and falls back to the built-in; the reaction still goes out.
- `instances.<name>.status_emojis` overrides this per instance. Resolution, per key: instance → channel → built-in.
- Reactions an AgEnD bot stamps from its own status set never reach an instance as a user reaction. Once every bot's user id is known, humans' reactions always pass, whatever emoji they use.
- Each instance's instructions list its own status set as the emojis to avoid (the five delivery statuses; `photo`/`attachment` are stamps on a saved file, not part of that ladder).
- **Settings** edits both maps: the connection's (Bots → Settings → Status emojis) and an agent's override (agent → Status emojis). The picker offers unicode emojis, Telegram's reaction set on a Telegram connection, and on Discord the server's own custom emojis, fetched with the bot token. The preview is resolved by AgEnD exactly as the bot will react.

---

### defaults

All fields from `instances.<name>` can be set here as shared defaults. Additional defaults-only fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `startup.concurrency` | number | `10` | Max instances starting simultaneously |
| `startup.stagger_delay_ms` | number | `500` | Delay between startup groups (ms) |
| `cost_guard.daily_limit_usd` | number | `0` (disabled) | Fleet-wide daily cost limit |
| `cost_guard.warn_at_percentage` | number | `80` | Warn threshold (% of limit) |
| `cost_guard.timezone` | string | system TZ | IANA timezone for daily reset |
| `hang_detector.enabled` | boolean | `true` | Enable stuck instance detection |
| `hang_detector.timeout_minutes` | number | `15` | Minutes of no output before alert |
| `daily_summary.enabled` | boolean | `true` | Enable daily cost/status report |
| `daily_summary.hour` | number | `21` | Report hour (local time) |
| `daily_summary.minute` | number | `0` | Report minute |
| `scheduler.max_schedules` | number | — | Max cron schedules |
| `scheduler.default_timezone` | string | — | Default timezone for schedules |
| `scheduler.retry_count` | number | — | Schedule retry count |
| `scheduler.retry_interval_ms` | number | — | Schedule retry interval |
| `webhooks` | WebhookConfig[] | — | Outbound webhook notifications |
| `warm_cap` | number | `0` (unlimited) | Fleet-wide cap on simultaneously warm (running) instances. When the running count exceeds it, the least-recently-active idle instance is auto-paused. `general` instances are never evicted. Complementary to `auto_pause_after` (time-based). |
| `warm_overflow` | number | `2` | With `delivery_worker` set to `wake_only` (the default) or `on`, how far `warm_cap` may be exceeded to wake a target that has queued work. No effect when `warm_cap` is `0` |
| `delivery_worker` | `"off"` \| `"wake_only"` \| `"on"` | `"wake_only"` | Phase 2 delivery owner (2.1.9; default `wake_only` since #1129). `wake_only` wakes a paused target when cross-instance work is queued for it. `off` never does: work for an instance paused across a fleet restart waits for a manual `/wake`. `on` (canary) also hands that target's delivery lane to a per-instance worker. Can be overridden per instance (`instances.<name>.delivery_worker`) |
| `progress_min_elapsed` | number | `30` | Seconds before the live-progress line / cancel button starts showing elapsed time. |
| `max_cross_instance_message_bytes` | number | `12288` | Maximum UTF-8 byte size of a cross-instance message body. Oversized messages are rejected with guidance to shorten them or send a file path. |
| `locale` | `"en"` \| `"zh-TW"` | auto-detects from timezone | UI/notification language for user-facing text. |

---

### instances.\<name\>

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `working_directory` | string | auto-created | Absolute path to project directory |
| `display_name` | string | — | Agent display name (set by agent) |
| `status_emojis` | object | — | This instance's own delivery-status emojis; overrides `channel.options.status_emojis` per key (see there) |
| `description` | string | — | Human-readable role description |
| `tags` | string[] | — | Capability tags for discovery |
| `topic_id` | number \| string | auto-created | Telegram topic ID or Discord thread ID |
| `channel_id` | string | — | Bound channel adapter ID (for multi-channel) |
| `general_topic` | boolean | `false` | Mark as General dispatcher instance |
| `backend` | string | `"claude-code"` | CLI backend: `claude-code`, `codex`, `opencode`, `kiro-cli`, `antigravity`, `grok`, `muse` |
| `kiro_ui` | `"legacy"` \| `"tui"` | `"legacy"` | Kiro-only launch mode. `legacy` runs on kiro's v1 engine and `tui` on its v2 engine; both are pinned on every launch so a kiro-cli default or saved setting cannot move an instance to another engine (#1109). `"v3"` is refused by validation until Kiro's v3 interface can run unattended (#849). |
| `model` | string | — | Model override (format depends on backend) |
| `model_failover` | string[] | — | Ordered fallback models on rate limit |
| `auto_pause_after` | number | `0` (disabled) | Minutes idle before auto-pause. 0 = disabled. |
| `agent_mode` | `"mcp"` \| `"cli"` | `"mcp"` | Communication mode. `"mcp"` is the default for every backend, Antigravity included; `"cli"` opts into `agend-agent` HTTP commands |
| `tool_set` | string | `"worker"` | Tool profile: `"worker"` (the default — talk, read, do the work), `"coordinator"` (worker plus the verbs that run the fleet: create/delete/restart instances, teams, schedules), `"full"` (every tool), `"standard"` (26), `"minimal"` (7). Not user-settable: `"general"` (dispatcher profile) is assigned internally to General instances only — setting it by hand fails validation. |
| `tool_progress` | `"off"` \| `"standard"` \| `"verbose"` | `"off"` | Tool-activity detail shown in the channel's processing bubble. `standard` shows semantic labels with no shell arguments; `verbose` adds truncated command previews. Opt-in — the bubble broadcasts activity into the channel. |
| `effort` | string | — | Default reasoning effort for this instance (`low`/`medium`/`high`/`xhigh`/`max`, clamped per backend). Runtime override via the `/effort` command — see [commands.md](./commands.md). |
| `backend_options` | object | — | Per-backend options keyed by backend name, e.g. `{ codex: { provider: "glm" } }`. See **Credential profiles** below for `credential_profile`. |
| `terminal.enabled` | boolean | `true` | Logical terminal size feature toggle. `false` pins the window to tmux's historical 80x24 for compatibility. |
| `terminal.columns` | number | `120` | Terminal width when `terminal.enabled` is `true`. |
| `terminal.rows` | number | `36` | Terminal height when `terminal.enabled` is `true`. |
| `mcp_auto_restart` | boolean | `true` | Restart the instance (idle-gated, session resumed) when its MCP server dies, or never connects within 90 seconds of the CLI starting. `false` = notify only. |
| `mcp_proxy_reply` | boolean | `false` | Opt-in: when the MCP server is dead at end of turn and no reply was sent, the daemon relays the pane's final text to the channel (marked ⚠️ as proxy reply). Off by default — raw pane text can leak content redaction doesn't catch. |
| `lightweight` | boolean | `false` | Skip non-essential subsystems |
| `systemPrompt` | string | — | Custom system prompt (supports `file:path` syntax) |
| `workflow` | string \| false | `"builtin"` | Workflow template: `"builtin"`, `"file:path"`, inline, or `false` |
| `skipPermissions` | boolean | — | Skip CLI permission checks. OpenCode: launched with `--auto` when its `--help` lists it (explicit `deny` rules still apply); an older OpenCode gets no launch switch and its prompts are answered "Allow once" at runtime |
| `pre_task_command` | string | — | Raw command pasted before each user message |
| `startup_timeout_ms` | number | `25000` | CLI startup timeout (ms) |
| `log_level` | string | `"info"` | `"debug"`, `"info"`, `"warn"`, `"error"` |
| `worktree_source` | string | — | Original repo path (when using git worktree) |
| `cost_guard` | CostGuardConfig | — | Per-instance daily cost limit (overrides fleet) |
| `restart_policy.max_retries` | number | `10` | Max crash restarts |
| `restart_policy.backoff` | string | `"exponential"` | `"exponential"` or `"linear"` |
| `restart_policy.reset_after` | number | `300` | Seconds of uptime before retry count resets |
| `restart_policy.health_check_interval_ms` | number | `30000` | Health check polling interval |
| `context_guardian.grace_period_ms` | number | `600000` | Grace period before context rotation (ms) |
| `context_guardian.max_age_hours` | number | `0` (disabled) | Force rotation after N hours |

---

### teams

```yaml
teams:
  reviewers:
    description: "Code review team"
    members: [reviewer-a, reviewer-b]
```

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Team purpose |
| `members` | string[] | Instance names |

---

### templates

```yaml
templates:
  sprint-team:
    description: "Sprint development team"
    team: true
    instances:
      dev:
        backend: claude-code
        model: sonnet
      reviewer:
        backend: kiro-cli
        tool_set: minimal
```

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Template description |
| `team` | boolean | Auto-create team from deployed instances |
| `instances` | object | Instance definitions (same fields as InstanceConfig) |

---

### profiles

Reusable backend/model presets referenced by template instances via `profile: name`.

```yaml
profiles:
  heavy:
    backend: claude-code
    model: opus
  light:
    backend: kiro-cli
    lightweight: true
```

---

### webhooks

```yaml
defaults:
  webhooks:
    - url: https://example.com/hook
      events: [instance.started, instance.stopped]
      headers:
        Authorization: "Bearer token"
```

---

## classicBot.yaml

Located at `~/.agend/classicBot.yaml`. Manages ClassicBot channels (auto-created on first `/start`).

### defaults

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backend` | string | `"claude-code"` | Default backend for all classic channels |
| `model` | string | — | Default model for all classic channels |
| `context_lines` | number | `50` | Chat history lines injected before each message (0 = disable) |
| `allowed_guilds` | string[] | `[]` | Discord server IDs allowed to use ClassicBot (empty = all) |
| `allowed_groups` | string[] | `[]` | Telegram group IDs allowed |
| `allowed_users` | string[] | `[]` | User IDs allowed to interact |
| `admin_users` | string[] | `[]` | User IDs with admin access (/start, /stop, /raw, /compact, /save, /load, /collab) |

### channels.\<channelId\>

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | — | Channel display name |
| `backend` | string | defaults.backend | Backend override |
| `model` | string | defaults.model | Model override |
| `context_lines` | number | defaults.context_lines | Chat history lines override |
| `collab` | boolean | `false` | Collaboration mode (@mention trigger) |
| `pre_task_command` | string | — | Raw command pasted before each message |
| `createdBy` | string | — | User ID who created this channel |
| `createdAt` | string | — | ISO timestamp |

### Key behaviors

- **Backend fallback**: channel → `defaults.backend` → `fleet.yaml` defaults → `claude-code`
- **Hot reload**: changes detected every 30 seconds
- **Instance naming**: `classic-<sanitized-channel-name>-<last4-of-channelId>`
- **DC auto-collab**: Discord `/start` auto-enables collab mode (bot messages visible without @mention)
- **Fleet /collab**: per-instance in-memory toggle (non-persistent, resets on fleet restart). Allows bot/webhook messages to reach a fleet topic instance.

### Telegram ClassicBot commands

In a Telegram group, address the bot explicitly: `/start@YourBot codex` (or
`/start@YourBot` to choose a backend). Use the bot's Telegram username, not its
AgEnD instance name. Group commands without `@YourBot` are intentionally ignored;
private chats accept `/start` without a suffix.

Each bot connection has its own ClassicBot registration and message dedup scope,
including the first command before registration. When multiple AgEnD bots see
the same group message, a sibling rejecting `/start@YourBot` cannot consume
YourBot's command. Retransmission to the same bot is still ignored. Group/user
allowlists and the admin requirement for starting in a group still apply.

This only applies to updates AgEnD receives. Telegram's privacy mode affects
which group messages reach a bot; see the [Telegram Bots FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get).
If an explicitly targeted command fails, first check whether its update arrived
at the intended adapter, then check polling errors/webhooks and routing. Another
bot being online alone does not establish which layer lost the command.

## Credential profiles (multiple subscriptions of one backend)

A CLI backend keeps its login in one place, so every instance in a fleet shares
one account. `credential_profile` gives a named, separate copy of that place:

```yaml
instances:
  work-agent:
    backend: kiro-cli
    backend_options:
      kiro-cli:
        credential_profile: work
  personal-agent:
    backend: kiro-cli
    backend_options:
      kiro-cli:
        credential_profile: personal
```

Instances naming the same profile share a login; instances naming different
profiles have different ones. **An instance with no `credential_profile` is
unaffected** — nothing is added to its launch and no directory is created for
it, so this feature cannot change the behaviour of a fleet that does not use it.

A profile lives in `~/.agend/credential-profiles/<backend>/<profile>` — under the
fleet rather than under an instance, so several agents can point at one
subscription. Log a profile in once from the host:

```bash
XDG_DATA_HOME=~/.agend/credential-profiles/kiro-cli/work kiro-cli login
```

Only the login is duplicated. The multi-gigabyte runtimes kiro downloads (`kas`,
`node`, `bun`, `cli-checkouts`) are symlinked back to the shared copy, so a
second profile costs megabytes rather than gigabytes. The store itself is never
a symlink — SQLite follows a linked database to its target, which would leave
the profile sharing the very login it exists to separate.

**A profile starts empty apart from those caches.** Anything the backend keeps
beside its login and that is not a shared cache — kiro's `knowledge_bases`, its
shell `history` — belongs to the profile, so an agent moved to a new profile
starts with none of it. Its conversations are inside the login database itself
(see [Switching is a new conversation](#switching-is-a-new-conversation)). That is the point of the
isolation, but `knowledge_bases` disappearing is the part people do not expect;
copy it across by hand if you want it in both.

Switching an existing agent is a config change plus a restart:

```
update_instance_config(name: "research-a",
  config: { backend_options: { "kiro-cli": { credential_profile: "personal" } } })
```

The credentials are read when the CLI launches, so AgEnD restarts the instance
for you and says `restarted: true`. A paused or stopped agent is not started:
its new profile applies when it next comes up. Send `credential_profile: null`
to put an agent back on the default login. Ask General in plain language — "move
research-a to the personal subscription" — and it will do this.

**Switching to a profile that has never been logged in is refused**, and the
error carries the command to log it in. kiro-cli does not start a signed-out
session: it stops at `Welcome to Kiro CLI, let's get you signed in!` and waits
for a keypress, so an agent pointed at an empty profile would sit on a login
screen until its startup budget expired, then restart into the same screen.
Going *back* to the default login is never refused — that is the way out of a
bad switch.

### Switching is a new conversation

kiro keeps its conversations in the same `data.sqlite3` as its login, keyed by
working directory. A different subscription is therefore a different set of
conversations, and there is nothing to resume — the store the agent was talking
into is the one being left behind. AgEnD does not try: the first launch after a
switch skips resume outright, rather than spending the resume startup budget
waiting for a conversation that is not there.

What does carry across is the *intent*. AgEnD takes the outgoing session's
context from the daemon (recent messages, recent activity — not from the CLI's
own store) and delivers it to the new session as a handover, saying which
subscription it came from and that the conversation did not come with it. The
reply reports `conversation_carried_over: false` and `handover_chars`.

This is a property of kiro, not a design choice: auth and conversations are
tables in one file, and a table cannot be symlinked back to the shared store.

### Seeing both quotas

`/usage`, `get_usage` and the dashboard show **one row per subscription**, not
one per backend: a fleet with a `work` and a `personal` kiro profile gets
`Kiro (work)` and `Kiro (personal)`, each read from its own store. A backend
with no profiles keeps its single row, reading the shared login.

A profile that is configured but never logged in keeps its row too, reading
`Signed out — run kiro-cli to log in`: when you are setting up a second
subscription, the one still to be logged in is exactly the row you need to see.
A row only disappears when the CLI itself is absent from the machine.

The rows are never added together. Two subscriptions have two quotas, and a
combined number would be true of neither — which is also the quickest way to see
whether two logins really are separate billing accounts: spend against one and
watch only that row move.

### Codex, and why it behaves differently

Codex has profiles too, and switching one **keeps the conversation** — the
opposite of kiro, for a reason that is nobody's choice. Kiro stores its
conversations in the same `data.sqlite3` as its login, so a different
subscription is a different set of them. Codex stores its login in one file,
`auth.json`, beside conversation stores (`sessions/` and the thread/state/memory
databases) that carry no account at all. Swapping the file swaps the account and
leaves the history where it is — which also means **both subscriptions see the
same history**.

Log a codex profile in with its own variable:

```bash
CODEX_HOME=~/.agend/credential-profiles/codex/work codex login
```

AgEnD does not move `CODEX_HOME` for a profile: every instance already has its
own codex home so its `config.toml` stays private, and a profile only changes
where that home's `auth.json` points. Everything else — sessions, the databases,
the caches — still comes from the shared home.

Two things about codex are **not yet verified**, because they need a second
billing account: whether the two subscriptions really meter separately, and
whether codex will reopen a conversation that was recorded under the other
account. If it will not, the agent starts a fresh conversation and carries on;
nothing breaks, it simply does not continue.

Implemented for `kiro-cli` and `codex`. Other backends keep their logins behind
their own variables; adding one is a new entry in `CREDENTIAL_HOMES`, not a new
mechanism.
