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
| `web` | object | no | — | Web UI feature toggles — `web.usage_panel: false` hides the AI subscription usage panel on /view and disables `/api/ai-usage` (default `true`); `web.allowed_hosts: [name, …]` adds `Host` names the dashboard answers to when reached through a reverse proxy or port forward (default: `localhost`, `127.0.0.1`, `[::1]` and `hostname`; any other `Host` gets 403 — this is what stops DNS rebinding; the `/login` browser terminal's listener uses the same list); `web.view_access: session` closes `/view` to anyone who is not signed in (default `open`: reading is open on the loopback listener; **saving a profile always needs a sign-in**); `web.notify_login: false` stops the General topic being told about each web sign-in (default `true`); `web.preview: false` turns off HTML previews in the web chat — no preview listener, cards show Source and Download only (default `true`; even then a browser runs a preview only after that device opts in); `web.preview_port` is the preview listener's port on `127.0.0.1` (default `health_port + 1`, i.e. 19281 — forward it too when you use the dashboard over SSH); `web.preview_origin: https://preview.example.net` is a separate host name a proxy maps to the preview listener, needed for previews through a tunnel or proxy (a bare origin; not a name the dashboard answers to) |
| `needs_you` | object | no | — | **"Needs you"** (#1386): one list of everything waiting on a person — fleet prompts (not responding / exited / waiting at its terminal), an instance at a permission, dangerous-command, sign-in or other dialog, an instance paused for sign-in or crashed, and deliveries the fleet could not confirm or deliver (last 24 h). `needs_you.live_message` (default `true`): each bot keeps one live message in **its own** General listing only the instances it owns — edited as things are resolved, re-posted (at most once a minute) when something new appears; each line links to the prompt's own buttons or the instance's thread, and an undeliverable/unconfirmed delivery gets an **Acknowledge** button for that bot's admins. `needs_you.dm` (default `false`): also DM that bot's admins when something new appears (a terminal wait only after 5 s; at most one DM a minute). The web dashboard shows every bot's items. Both keys apply without a restart. |
| `web_terminal` | object | no | — | The browser terminal behind `/login` (sign-in and install): `enabled` (default `true`), `bind` (default `127.0.0.1`), `ttl_minutes` (1–20, default 10), and `tunnel` — a public link for `/login`, offered at each login unless `allow_public: false`, see [Finishing a /login away from the machine](#finishing-a-login-away-from-the-machine-public-link) |

---


### Temporary public dashboard link

`web.public_link.allow_public` defaults to `true` (offer only; explicit General admin click required), `ttl_minutes` to `120` (1–480, fixed from consent), and `protocol` to `http2` (`quic`/`auto` also accepted). Settings edits these without writing defaults on unrelated changes. Disabling closes an active link. The public host is ephemeral, `/view` requires sign-in and previews are disabled there. See [web dashboard](web-dashboard.md#temporary-public-link-from-a-phone) for private delivery, session scope and risks.

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
| `access` | AccessConfig | no | open fallback when the whole block is omitted | Access control settings; persisted state can override (see below) |
| `options` | object | no | — | Platform-specific options (e.g. `general_channel_id` for Discord) |
| `telegram_api_root` | string | no | `"https://api.telegram.org"` | Override Telegram Bot API URL |
| `mirror_topic_id` | number \| string | no | — | Topic ID for cross-instance message mirroring |

#### channel.access

`access` is optional. **Omitting the entire block uses an `open` runtime fallback**, not `locked`; an existing persisted mode can still override it. To restrict chat access, explicitly set `mode: locked` and `allowed_users`.

The fallback values below apply only when the whole block is omitted; an explicit block is not filled field by field. Set `mode`, an `allowed_users` array and, for pairing, the pairing limits explicitly.

| Field | Type | Whole-block fallback | Description |
|-------|------|----------------------|-------------|
| `mode` | `"locked"` \| `"pairing"` \| `"open"` | `"open"` | `locked`/`pairing` admit the effective allowlist; `pairing` also accepts `/pair` requests. `open` admits all users; bots have separate ingress filters, see [permissions](permissions.md#bot-and-webhook-messages) |
| `allowed_users` | (number\|string)[] | `[]` | Unioned with the persisted list; IDs compare as strings |
| `max_pending_codes` | number | `0` | Max distinct users with pending pairing codes; set a positive limit for pairing |
| `code_expiry_minutes` | number | `0` | Pairing code TTL in minutes; set a positive duration for pairing |

**Persisted state and administration:**

- The primary adapter uses `<dataDir>/access/access.json`; additional adapters use `access/access-<adapterId>.json`. `dataDir` defaults to `~/.agend`, or `AGEND_HOME` when set.
- A saved mode takes precedence over YAML. Saved users and YAML `allowed_users` are unioned and deduplicated; approved pairing adds to the saved list.
- Under `locked`/`pairing`, revocation must remove the grant from both lists; changing only one can leave access enabled. `open` does not restrict users in the first place.
- Fleet admin commands separately require an entry in the **invoking adapter's YAML `access.allowed_users`**. Open access or approved pairing alone does not grant fleet admin; an empty YAML list grants nobody that role. ClassicBot has separate `defaults.admin_users`; see [permissions](permissions.md).

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
- A change to a connection's `status_emojis` applies at the bot's next stamp, with no restart. Each agent's "avoid these" list follows at its next start. The rest of a connection (binding, access, token) still needs an AgEnD restart.
- `progress_prefix` is not a reaction: it is the emoji at the start of the progress message, so Telegram's reaction set does not limit it.

---

### defaults

All fields from `instances.<name>` can be set here as shared defaults. Additional defaults-only fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `startup.concurrency` | number | derived, `2`–`10` | Shared spawn-gate concurrency, based on free RAM and CPU count when omitted. An explicit value must be `1`–`20`. |
| `startup.stagger_delay_ms` | number | `500` | Minimum spacing between spawn admissions (ms), across startup, wake, recovery and restart; not a delay between groups. Valid range: `0`–`30000`. |
| `cost_guard.daily_limit_usd` | number | `0` (disabled) | Fleet-wide daily cost limit |
| `cost_guard.warn_at_percentage` | number | `80` | Warn threshold (% of limit) |
| `cost_guard.timezone` | string | system TZ | IANA timezone for daily reset |
| `hang_detector.enabled` | boolean | `true` | Enable stuck instance detection |
| `hang_detector.timeout_minutes` | number | `15` | Minutes of no output before alert |
| `daily_summary.enabled` | boolean | `true` | Enable daily cost/status report |
| `daily_summary.hour` | number | `21` | Report hour (local time) |
| `daily_summary.minute` | number | `0` | Report minute |
| `scheduler.max_schedules` | number | `100` | Max schedules |
| `scheduler.default_timezone` | string | `"Asia/Taipei"` | Default timezone for schedules |
| `scheduler.retry_count` | number | `3` | Retries after the initial delivery attempt |
| `scheduler.retry_interval_ms` | number | `30000` | Schedule retry interval (ms) |
| `webhooks` | WebhookConfig[] | `[]` | Outbound webhook notifications |
| `warm_cap` | number | `0` (unlimited) | Fleet-wide cap on simultaneously warm (running) instances. When the running count exceeds it, the least-recently-active idle instance is auto-paused; General and instances with work leases are spared. Complementary to `auto_pause_after` (time-based). |
| `warm_overflow` | number | `2` | With `delivery_worker` set to `wake_only` (the default) or `on`, how far `warm_cap` may be exceeded to wake a target that has queued work. No effect when `warm_cap` is `0` |
| `delivery_worker` | `"off"` \| `"wake_only"` \| `"on"` | `"wake_only"` | Phase 2 delivery owner (2.1.9; default `wake_only` since #1129). `wake_only` wakes a paused target when cross-instance work is queued for it. `off` never does: work for an instance paused across a fleet restart waits for a manual `/wake`. `on` (canary) also hands that target's delivery lane to a per-instance worker. Can be overridden per instance (`instances.<name>.delivery_worker`) |
| `progress_min_elapsed` | number | `30` | Seconds before the live-progress line / cancel button starts showing elapsed time. |
| `max_cross_instance_message_bytes` | number | `12288` | Maximum UTF-8 byte size of a cross-instance message body. Oversized messages are rejected with guidance to shorten them or send a file path. |
| `reply_overdue_minutes` | number | `15` | Minutes since the last ask/reminder before notifying the requester once that a `requires_reply` request is unanswered and its owner is not working. `0` disables requester notices, not owner reminders. |
| `retention_days` | number | `30` | How many days to keep terminal deliveries (`delivered`/`failed`) in `delivery-outbox.db` and `done`/`cancelled` tasks on the Task Board. `uncertain` and non-terminal rows are never pruned. Pruning runs once at fleet startup and daily after that, in chunks of 500 rows so it never stalls the event loop. A `delivery_status` query for a pruned delivery_id returns "older than the retention window; record pruned" instead of "Delivery not found". |
| `tips` | boolean | `true` | Daily General-topic tips and update-completion tips. Independent of `daily_summary.enabled`. |
| `locale` | `"en"` \| `"zh-TW"` | auto-detects from timezone | UI/notification language for user-facing text. |

---

### instances.\<name\>

`tool_set` enforces policy for the resolved instance identity, not isolation between shell-capable agents on the same uid. A sibling can read another instance’s `agent.token` or use its IPC socket; see [the shared-account threat model](SECURITY.md#tool-profiles-and-the-shared-host-account).

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
| `tool_set` | string | `"worker"` | Tool profile: `"worker"` (the default — talk, read, do the work), `"coordinator"` (worker plus the verbs that run the fleet: create/delete/restart instances, teams, schedules), `"full"` (every tool), `"standard"` (29), `"minimal"` (9). Not user-settable: `"general"` (dispatcher profile) is assigned internally to General instances only — setting it by hand fails validation. |
| `tool_progress` | `"off"` \| `"standard"` \| `"verbose"` | `"off"` | Tool-activity detail shown in the channel's processing bubble. `standard` shows semantic labels with no shell arguments; `verbose` adds truncated command previews. Opt-in — the bubble broadcasts activity into the channel. |
| `cross_instance_visibility` | `"full"` \| `"summary"` \| `"hidden"` | `"full"` | How much of a bot-to-bot (cross-instance) message is posted in this instance's topic, on whichever side it is: `full` the whole message (as before), `summary` one line, `hidden` nothing. Set under `defaults` for the fleet (also with `/visibility`), here to override it for one instance; Settings has both. Applies at once, without a restart. Delivery and the Mirror Topic are never affected — see [features](features.md#bot-to-bot-message-visibility). |
| `effort` | string | — | Default reasoning effort for this instance (`low`/`medium`/`high`/`xhigh`/`max`, clamped per backend). Runtime override via the `/effort` command — see [commands.md](./commands.md). |
| `backend_options` | object | — | Per-backend options keyed by backend name, e.g. `{ codex: { provider: "glm" } }`. See **Credential profiles** below for `credential_profile`. |
| `terminal.enabled` | boolean | `true` | Logical terminal size feature toggle. `false` pins the window to tmux's historical 80x24 for compatibility. |
| `terminal.columns` | number | `120` | Terminal width when enabled; integer `80`–`300`. |
| `terminal.rows` | number | `36` | Terminal height when enabled; integer `24`–`120`. |
| `mcp_auto_restart` | boolean | `true` | Restart/resume when MCP dies or never connects within 90 seconds of CLI startup. Normally waits for idle, with a 30-minute forced-restart backstop; unresolved auth trouble suppresses automatic restart. `false` = notify only. |
| `mcp_proxy_reply` | boolean | `false` | Opt-in: when the MCP server is dead at end of turn and no reply was sent, the daemon relays the pane's final text to the channel (marked ⚠️ as proxy reply). Off by default — raw pane text can leak content redaction doesn't catch. |
| `reply_completion_guard` | boolean | `true` | Bounded recovery when a human turn ends without a delivered reply. Requires backend support: Claude Code, successfully built Kiro legacy/TUI launches, and Codex (only when its rollout shows the turn ended); not Kiro v3 or other backends. Also configurable in Classic defaults/per-channel entries. |
| `lightweight` | boolean | `false` | Skip non-essential subsystems |
| `systemPrompt` | string | — | Additional instructions, inline or `file:path`, delivered through the native route below. A relative file path resolves under the instance's `working_directory`; several parts are joined with commas — see [features](features.md#systemprompt-file-paths). |
| `workflow` | string \| false | `"builtin"` | Workflow template: `"builtin"`, `"file:path"` (relative to the instance's `working_directory`), inline, or `false` |
| `skipPermissions` | boolean | effectively `true` unless `false` | Permission bypass uses backend-specific flags; see [security boundaries](SECURITY.md). OpenCode: launched with `--auto` when its `--help` lists it (explicit `deny` rules still apply); an older OpenCode gets no launch switch and its prompts are answered "Allow once" at runtime |
| `pre_task_command` | string | — | Raw command pasted before each user message |
| `startup_timeout_ms` | number | `25000` | CLI startup timeout (ms) |
| `log_level` | string | `"info"` | `"debug"`, `"info"`, `"warn"`, `"error"` |
| `worktree_source` | string | — | Original repo path (when using git worktree) |
| `cost_guard` | CostGuardConfig | — | Per-instance daily cost limit (overrides fleet) |
| `restart_policy.max_retries` | number | `10` | Max crash restarts |
| `restart_policy.backoff` | string | `"exponential"` | `"exponential"` or `"linear"` |
| `restart_policy.reset_after` | number | `300` | Seconds of uptime before retry count resets |
| `restart_policy.health_check_interval_ms` | number | `30000` | Health check polling interval |
| `context_guardian.grace_period_ms` | number | — | Deprecated compatibility field: ignored, with a validation warning. |
| `context_guardian.max_age_hours` | number | — | Deprecated compatibility field: ignored, with a validation warning. |

The context guardian monitors CLI status for the dashboard and logs. It does not
rotate or restart sessions based on context usage or session age; context limits
are handled by each CLI's own compaction. The legacy fields above have no built-in
defaults and no effect.

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
| `instances` | object | Template definitions: `description`, `backend`, `model`, `model_failover`, `tool_set`, `systemPrompt`, `skipPermissions`, `lightweight`, `workflow`, `tags`, and optional `profile`. |

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
      events: [cost_warning, hang]
      headers:
        Authorization: "Bearer token"
```

Emitted events are `hang`, `mcp_died`, `pty_error`, `pty_recovered`,
`cost_warning`, `cost_limit`, `schedule_deferred`, `model_failover` and
`model_recovered`. Use `events: ["*"]` to subscribe to all emitted events.
`instance.started`, `instance.stopped`, `rotation` and `crash_loop` are not emitted.

---

## Fleet instructions and session context

MCP server instructions provide a compact identity, reply and cross-instance
messaging contract. Full fleet guidance — role, workflow, selected decisions and
`systemPrompt` — uses each backend's native instruction route:

| Backend | Full instruction route |
|---------|------------------------|
| Claude Code | Instance `fleet-instructions.md`, loaded with additive `--append-system-prompt-file` |
| Codex | Managed AgEnD marker block in the workspace's `AGENTS.md` |
| Kiro CLI | The `prompt` of the instance's own agent, `.kiro/agents/agend-<instance>-<fleet>.json`; the steering file `.kiro/steering/agend-<instance>.md` on kiro-cli < 2.21 and until a resumed conversation is switched to its agent |
| OpenCode | Instance `fleet-instructions.md` appended to the project's `opencode.json` `instructions` array |
| Antigravity | Managed marker block in workspace `.agents/agents.md` |
| Grok / Muse | Managed marker block in workspace `AGENTS.md` |

Normal updates of complete managed marker blocks preserve surrounding content.
Cleanup of a malformed block with no END marker can remove BEGIN through EOF.
OpenCode and Kiro
do not depend on reading MCP's `instructions` field for full fleet context.
Codex's project-document size limit can still truncate a large `AGENTS.md`.

Set `workflow` in `defaults.workflow` or `instances.<name>.workflow`, **not at the
root of `fleet.yaml`**. The default is `"builtin"`; inline content, `file:path`
and `false` are supported. `systemPrompt` uses the same native routes whether
inline or loaded from a file; it is not delivered solely through MCP. Relative
`workflow` and `systemPrompt` file paths resolve under the instance's
`working_directory` (#1314; until 2.2 a file found only at the old fleet-directory
location is still used, with a warning).

### Active Decisions

Fleet startup snapshots up to 20 active decisions, with each content capped at
200 characters. Each daemon selects relevant decisions; its instructions show up
to 15 summaries, each capped at 120 characters, and point to `list_decisions` for
more. This is a startup snapshot, not a live feed: use `list_decisions` for current
full decisions, including ones posted after startup.

### Session snapshots

Crash recovery can write `rotation-state.json`; the historical filename does not
mean context-based rotation is enabled. On a later launch the daemon consumes
the snapshot and attempts to send it as background context prefixed
`[system:session-snapshot]`. It is not embedded in the instruction files. Reading
marks it consumed for that startup and attempts to delete the file, normally
preventing replay on later restarts.

---

## classicBot.yaml

Located at `~/.agend/classicBot.yaml`. Manages ClassicBot channels (auto-created on first `/start`).

### defaults

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backend` | string | `"claude-code"` | Default backend for all classic channels |
| `model` | string | — | Default model for all classic channels |
| `context_lines` | number | `5` | Chat history lines injected before each message (0 = disable) |
| `allowed_guilds` | string[] | `[]` | Discord server IDs granted new ClassicBot starts; empty/unset requests approval |
| `allowed_groups` | string[] | `[]` | Telegram group IDs granted access; empty/unset requests approval |
| `allowed_users` | string[] | `[]` | Telegram private user IDs granted new starts; empty/unset requests approval |
| `admin_users` | string[] | `[]` | Classic admin user IDs. Command gates differ by platform; see the [command surface matrix](command-surface.md). Classic Telegram `/raw` is currently blocked; hidden Fleet `/raw` requires the owning bot's F. |
| `reply_completion_guard` | boolean | inherited | Per-channel → Classic defaults → fleet defaults → `true`; requires the backend capability described above. |

New starts: ClassicBot admins (`admin_users`) may start directly. Other callers need an explicit guild/private-user grant; unlisted callers request General approval through **Allow / Allow+admin / Ignore** buttons. Telegram private approvals add the user to `allowed_users`. Telegram group starts still require a ClassicBot admin; Allow grants only the group, while Allow+admin also promotes the requester. Existing registered channels keep working, and Discord DMs remain unsupported. Approval does not start an agent: retry `/start` (groups: `/start@OurBot`).

### channels.\<channelId\>

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | — | Channel display name |
| `channelId` | string | entry key | Actual channel/chat ID when different from the YAML key |
| `adapterId` | string | inferred | Owning bot connection; non-primary connections add an adapter suffix to generated instance names |
| `instanceName` | string | generated | Persisted explicit instance name, when present, wins over generated naming |
| `backend` | string | defaults.backend | Backend override |
| `model` | string | defaults.model | Model override |
| `context_lines` | number | defaults.context_lines | Chat history lines override |
| `reply_completion_guard` | boolean | inherited | Override the human reply guard for this Classic channel |
| `collab` | boolean | `false` | Collaboration mode (@mention trigger) |
| `pre_task_command` | string | — | Raw command pasted before each message |
| `createdBy` | string | — | User ID who created this channel |
| `createdAt` | string | — | ISO timestamp |

### Key behaviors

- **Backend fallback**: channel → `defaults.backend` → `fleet.yaml` defaults → `claude-code`
- **Hot reload**: changes detected every 30 seconds
- **Instance naming**: `classic-<sanitized-channel-name>-<last4-of-channelId>`, plus a sanitized adapter suffix on non-primary connections. A persisted `instanceName` wins; otherwise the display `name` (or channel ID), rather than an arbitrary YAML key, supplies the name.
- **DC auto-collab**: Discord `/start` auto-enables collab mode. Messages are logged for context; triggering a turn still requires mentioning the bot.
- **Fleet /collab**: per-instance in-memory toggle (non-persistent, resets on fleet restart). Lets bot/webhook messages pass the fleet topic's bot prefilter; it does not replace access control.

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

For Kiro CLI and Codex, `backend_options.<backend>.credential_profile` selects a
named login isolated from the default shared login. Other backends warn that the
option is ignored. Names must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Set it under
an instance or shared defaults:

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

Instances naming the same effective profile share a login; different names
isolate their stores. With no effective profile after defaults inheritance, the
ordinary shared login is unchanged and no profile directory is created. Profiles
live in `~/.agend/credential-profiles/<backend>/<profile>`, shared across instances
that name the same profile.

### Kiro

Log the profile in once on the host:

```bash
XDG_DATA_HOME=~/.agend/credential-profiles/kiro-cli/work kiro-cli login
```

Kiro's login/conversation database remains a private file, never a symlink back
to the shared login. Large runtime caches (`kas`, `node`, `bun`, `cli-checkouts`)
link to the shared copy. A new profile starts empty apart from these caches;
`knowledge_bases`, shell `history` and other private entries belong to it. Copy
those across yourself if needed.

To switch an existing instance:

```
update_instance_config(name: "research-a",
  config: { backend_options: { "kiro-cli": { credential_profile: "personal" } } })
```

A changed launch option restarts a running instance; the reply says whether that
restart succeeded. Paused, stopped or crashed instances remain inactive and read
the new option at their next start. `credential_profile: null` clears the instance
override and inherits the fleet default; this uses the shared login only when no
named profile is inherited.

When `update_instance_config` changes the effective profile name to a different
named profile, it checks for a recognized stored login and refuses the switch
with a login command if absent. This is not a check of token freshness or a
promise about startup from manually edited YAML. Returning to the shared login
bypasses this named-profile check.

**Switching a running Kiro instance starts a fresh conversation.** Login and
conversations share one `data.sqlite3`; a different profile has a different set
of conversations. AgEnD skips resume for that fresh launch and attempts to hand
over recent messages/activity from daemon buffers, rather than copying the CLI
store. A successful restart reports `conversation_carried_over: false` and
`handover_chars`; the latter counts context sent through IPC, not confirmed
processing, and may be zero. The inactive-instance update path does not run this
handover or return those fields.

### Codex

```bash
CODEX_HOME=~/.agend/credential-profiles/codex/work codex login
```

A Codex profile changes **only the source of `auth.json`**. The instance keeps its
own CODEX_HOME and private `config.toml`; conversation and thread/state/memory
stores remain shared. A profile switch does not deliberately force a fresh
conversation, and both accounts can see the same history stores.

Reopening a conversation recorded under another account and separate metering
have not been verified with a second billing account. Shared history is not a
guarantee that cross-account resume will succeed.

### Seeing both quotas

`/usage`, `get_usage` and the dashboard show separate rows for effective
backend/profile bindings of running or paused instances. Active Kiro `work` and
`personal` profiles appear as `Kiro (work)` and `Kiro (personal)`; a shared-login
binding uses the default row. Sources used only by stopped or crashed instances
are filtered out.

An active Kiro profile without a readable login retains a signed-out hint.
Visibility also depends on the provider: Codex rows without OAuth usage
credentials, including API-key-only profiles, are omitted. Rows are not combined,
and different profile names do not guarantee different billing accounts.

### Web chat channel echo (2.2 web line)

Web chat echoes are enabled by default for fleet-topic instances. Set `web.echo_to_channel: false` to disable them, or use **Settings → General → Web chat**. The copy goes to the instance's own Telegram or Discord topic as `🌐 web · web-user: …`, with attachment names and a note pointing to web chat for long text. It is display only: echoes never become a new agent turn. Web-only fleets and ClassicBot rooms are excluded. A failed echo is logged without failing or delaying web message delivery. Each echo has a five-second total ordering budget, including queue and admission waits. Replies proceed when the send settles or the budget expires. On expiry, queued copies are dropped with a warning; an already in-flight copy may land after the reply, and its late outcome is logged. No echo retry is attempted.

Echo text and attachment names replace mention/command tokens with visible ASCII labels such as `[mention: 200]`, `[at: botname]` and `[command: cmd at bot]`. Compatibility normalisation and format-character removal happen first; URLs, email local parts and ordinary path slashes remain intact. Discord also sends with `allowedMentions: { parse: [] }`; Telegram sends plain text without mention entities. The common ingress drops the fixed `🌐 web · ` prefix when its author is one of the configured fleet bot accounts on that platform, independent of echo flags or send acknowledgements. While any configured world on the same platform has an unknown bot identity, bot-flagged prefix candidates are also dropped before trigger evaluation, with a debug log. This temporary quarantine never affects human copies; after all identities are known, non-fleet bots keep the existing admission/collab rules. No unknown author is classified as a fleet bot, and no recent-message cache is used.
