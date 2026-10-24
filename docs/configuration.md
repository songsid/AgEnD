# Configuration Reference

Complete reference for all AgEnD configuration files.

## fleet.yaml

Located at `~/.agend/fleet.yaml`. The primary configuration file for the fleet.

**YAML anchors and aliases** (`&admins` … `*admins`) work. Each place still has its own value: a change made in the
dashboard's Settings (or by an agent's config tools) changes only the place it names. If that place is an alias, it
gets its own copy. If it is the anchor, the other places keep the value they had. Anchors the change doesn't touch
stay as you wrote them. A save that would still change anything else is refused with the place it would have changed
(#2208).

### Top-level fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `channel` | object | no | — | Single channel config (legacy, use `channels[]` for multi-channel) |
| `channels` | ChannelConfig[] | no | — | Multi-channel config array |
| `project_roots` | string[] | no | — | Allowed directories for instance creation |
| `defaults` | object | no | `{}` | Shared defaults applied to all instances |
| `instances` | object | no | `{}` | Per-instance configuration (keyed by instance name) |
| `teams` | object | no | — | Named groups for targeted broadcasting |
| `templates` | object | no | — | Reusable fleet deployment templates |
| `profiles` | object | no | — | Reusable backend/model presets |
| `health_port` | number | no | `19280` | HTTP health endpoint port |
| `fleet_label` | string | no | host name | How this fleet names itself in `/login`: appended to the Discord slash command description and shown under each backend picker (`🖥 Fleet: …`). Every AgEnD bot in a guild registers its own `/login`, and each one controls only the fleet that runs it — the label tells them apart. Default: the machine's host name, plus the AgEnD home's directory name when it is not `~/.agend` |
| `web` | object | no | — | Web UI feature toggles — `web.usage_panel: false` hides AI subscription usage everywhere (the header's **Usage**, the right-hand panel and the dialog) and disables `/api/ai-usage` and the usage report (default `true`); `web.usage_report_on_public_link: true` also serves the usage report (#2122: up to 400 days of each agent's tokens, requests, delivered messages and API-equivalent amounts) over the temporary public link (default `false`: the local dashboard only; guests never get it; also in **Settings → Web dashboard** as **Usage report over the public link**, which applies at once); `web.log_tab: true` turns on each instance's **Log** tab (紀錄): its prompts, replies, tool calls and their results, errors and fleet events, read on demand from the agent's own transcript with secret values masked, and also over the public link (default `false`: off, it does no work at all; also in **Settings → Web dashboard**, where turning it on waits for a fleet admin's confirmation; claude-code and codex — kiro shows fleet events only for now, with the reason, until AgEnD can prove which conversation a kiro instance is in); `web.search` is the dashboard's global search (#2293) over chat messages, cross-instance messages and Task Board tasks — its own index, `search.db`, in the AgEnD home, built and kept by a worker thread off the fleet's loop, secrets masked, for admin sessions only, over the temporary public link too (never a guest): `enabled` (default `true`; `false` keeps no index and refuses searches at once, read at fleet start for the index), `retention_days` (from 2.3.1, unset and `0` = no age limit; a positive integer 1–3650 still age-prunes; at most 300,000 entries, the oldest go first; 2.3.0 default is 90 days), `public_link` (default `true`; `false` keeps search off the public link — no entry there, and the route answers 404 — while this machine keeps it); `web.allowed_hosts: [name, …]` adds `Host` names the dashboard answers to when reached through a reverse proxy or port forward (default: `localhost`, `127.0.0.1`, `[::1]` and `hostname`; any other `Host` gets 403 — this is what stops DNS rebinding; the `/login` browser terminal's listener uses the same list); `web.view_access: session` closes `/view` to anyone who is not signed in (default `open`: reading is open on the loopback listener; **saving a profile always needs a sign-in**); `web.notify_login: false` stops optional local sign-in notices in General (default `true`; public sign-ins still require their confirmed notice); `web.session.local.absolute_hours` / `web.session.local.idle_hours` set how long a sign-in on the dashboard reached directly (loopback, a LAN, a tailnet) lasts — hours since sign-in, and hours without use (defaults `48` / `48`; `1 ≤ idle_hours ≤ absolute_hours ≤ 720`, decimals allowed; a public-link session's 4 h / 30 min is fixed and not configurable; a change applies without a restart, and a shorter limit also ends the sessions it now outlives; also in **Settings → Access & security**, where a longer limit waits for a fleet admin's confirmation); `web.preview: false` turns off HTML previews in the web chat — no preview listener, cards show Source and Download only (default `true`; even then a browser runs a preview only after that device opts in); `web.preview_port` is the preview listener's port on `127.0.0.1` (default `health_port + 1`, i.e. 19281 — forward it too when you use the dashboard over SSH); `web.preview_origin: https://preview.example.net` is a separate host name a proxy maps to the preview listener, needed for previews through a tunnel or proxy (a bare origin; not a name the dashboard answers to); `web.themes.agent_edit: false` refuses every agent's changes to its own web theme (default `true`: an agent may change its own, rate-limited; what is stored stays, and people can still reset and lock it); `web.appearance` sets the identity card's upload limits and each agent's picture quota — `portrait` / `banner` each take `max_width`, `max_height` (px) and `max_kib`, `instance_quota` takes `files` and `mib` (defaults: portrait 1024×1536 / 1536 KiB, banner 1600×600 / 768 KiB, quota 8 files / 4 MiB; hard bounds: portrait 64–2048 × 64–3072 px and 32–4096 KiB, banner 64–3200 × 64–1200 px and 32–2048 KiB, quota 2–16 files and 1–16 MiB; a value outside its bound is clamped with a warning and never stops the fleet; a change applies to new uploads only, and nothing stored is deleted); `web.upload_max_file_mb` / `web.upload_max_total_mb` set the web chat's upload limits — one file, and all files on one message (whole MB, 1–500; defaults `50` / `100`; a file is never allowed more than a message; over the public link a file stays at 95 MB, the quick tunnel's limit; `agend reload` applies a change to the next upload); `web.guests` is guest web sign-in for people who are not admins (#1920; with it on, someone who isn't a fleet admin sends `/web` where they already chat and gets a guest sign-in code privately, for the dashboard reached directly and, while an admin has it open, the public link (a guest signing in through it is posted in that admin's General); they see only the agents they can already use in chat, and `/web revoke` from them signs out only their own guest sessions): `enabled` (default `false`; turning it off ends every guest session), `chat` (default `true`), `open_instances: { <connection id>: [instance, …] }` (an `open` connection's guests reach only the instances named here, none by default), `narrow: { "<connection id>:<user id>": [instance, …] }` (an admin's narrowing, which only takes away), `grants: { "<connection id>:<user id>": { name?, instances: [instance, …] } }` (#2348: an admin's explicit grants, set in **Settings → Access & security → Guests** — once this key exists it is the whole scope, default deny, and the derived access, `open_instances` and `narrow` give nothing; adding a person or an agent waits for a fleet admin, taking away applies at once) and `session.absolute_hours` / `session.idle_minutes` (defaults `12` / `120`; 1–24 h and 15–720 min; never longer than the surface's own limits); `web.verified_authority` decides when a signed-in web session's messages carry the account's authority in their delivery receipt (#1939; agents check a `web-verified` receipt like a Discord or Telegram message, and see its messages as `via web (verified)`): a session qualifies (a fleet admin's own account, the dashboard reached directly or, opt-in, a public link — see `named_link` and `quick_link` below; never a guest) and is then authorized once by that account confirming on Discord or Telegram, after which its messages are `web-verified` until it runs out or is revoked. `enabled` (default `true`: the server switch, on because nothing carries authority until the account confirms; while off, every web authority reads as none at once, and turning it back on never brings back authority given before), `loopback_only` (default `false`: a browser on a LAN or tailnet qualifies too; `true`: only a browser on this computer; turning it on makes earlier LAN authority read as none, and turning it off again doesn't bring it back) `max_session_hours` (default `48`; 1–48: how long an authorization lasts; later messages still send, without authority), `named_link` (default `false`: a browser over the admin's own named-tunnel hostname may be authorized too; turning it on is confirmed in a General or on the host) and `quick_link` (default `false`: likewise over the temporary public link `/web` opens; turning it on is confirmed the same way, and off applies at once). `/web revoke` also revokes all web authority given so far, and is the way to revoke when the switch was turned off and back on while AgEnD was stopped (that nets out to no change) |
| `needs_you` | object | no | — | **"Needs you"** (#1386): one list of everything waiting on a person — fleet prompts (not responding / exited / waiting at its terminal), an instance at a permission, dangerous-command, sign-in or other dialog, an instance paused for sign-in or crashed, and deliveries the fleet could not confirm or deliver (last 24 h). `needs_you.live_message` (default `true`): each bot keeps one live message in **its own** General listing only the instances it owns — edited as things are resolved, re-posted (at most once a minute) when something new appears; each line links to the prompt's own buttons or the instance's thread, and an undeliverable/unconfirmed delivery gets an **Acknowledge** button for that bot's admins. `needs_you.task_board` (default `false` since 2.3.0): also list the task board's cards that wait for you — cards waiting for your confirmation, and blocked cards you handed out (#2425); a card an agent handed out, or one an agent keeps for itself, is never listed. `needs_you.dm` (default `false`): also DM that bot's admins when something new appears (a terminal wait only after 5 s; at most one DM a minute). The web dashboard shows every bot's items. Both keys apply without a restart. Unchanged text and buttons stay in place; Acknowledge buttons still renew. Failed edits replace the message only after confirmed message/destination or permission loss, under the same one-post-per-minute limit; network, rate-limit and content errors keep the existing pointer. If you disabled `live_message` to avoid repeated Telegram messages, you can set it back to `true` after updating. |
| `web_terminal` | object | no | — | The browser terminal behind `/login` (sign-in and install): `enabled` (default `true`), `bind` (default `127.0.0.1`), `ttl_minutes` (1–20, default 10; `enabled` and `ttl_minutes` are also in **Settings → Access & security**, where turning the terminal on or giving it more minutes waits for a fleet admin's confirmation), and `tunnel` — a public link for `/login`, offered at each login unless `allow_public: false`, see [Finishing a /login away from the machine](#finishing-a-login-away-from-the-machine-public-link) |

---


### Temporary public dashboard link

`web.public_link.allow_public` defaults to `true` (offer only; explicit General admin click required), `ttl_minutes` to `120` (1–480, fixed from consent; with a fixed `hostname` 1–10080 or `0` = no expiry), and `protocol` to `http2` (`quic`/`auto` also accepted). Settings edits these without writing defaults on unrelated changes. Disabling closes an active link. Quick-tunnel hosts are ephemeral and `/view` requires sign-in. Previews come from a second quick tunnel of the link's own, started in the background and closed with it (`web.preview_on_public_link`, default `true`). See [web dashboard](web-dashboard.md#temporary-public-link-from-a-phone) for private delivery, session scope and risks.

For a fixed optional Cloudflare hostname, set `web.public_link.hostname`, `tunnel_token_env: AGEND_CLOUDFLARE_TUNNEL_TOKEN` and `origin_port` (default 19282), then set the write-only connector token in Settings → Access & security. Opening, Close and sign-in still apply; the same URL works after reopening. A fixed hostname also allows a longer lifetime and `auto_open` (reopen after a restart, default `false`). See the [named tunnel setup and acceptance guide](named-tunnel.md). Never point the Cloudflare route at the main dashboard port.


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
every use. **Where it comes from:** on Linux, Cloudflare's own package repository first (`pkg.cloudflare.com`, the
`.deb`, whose binary is unpacked by AgEnD itself), then the GitHub release when the package is missing, stalls, is too
slow or does not match. On macOS, GitHub only, since there is no package for it. Both are checked against the same
pinned SHA256. A download fails only when no data has arrived for 60 seconds, with an overall limit of 30 minutes, so a
slow connection that keeps moving finishes. AgEnD only installs into, and only trusts, a folder that is yours alone: if `~/.agend` (or its `bin`) is
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
| `mode` | string | no | `"topic"` | Must be `"topic"` |
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
- Fleet admin commands separately require an entry in the **invoking adapter's YAML `access.allowed_users`**. Open access or approved pairing alone does not grant fleet admin; an empty YAML list grants nobody that role, and `/web`, `/update` and `/doctor` are then off for that bot (the reply names the key). There is no `web.access`: `agend validate` warns about it and any other unknown key under `web`. These warnings, and every other one the validator gives, also show in `agend doctor` and in `daemon.log` when the fleet starts. ClassicBot has separate `defaults.admin_users`; see [permissions](permissions.md).

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
- **Settings** edits both maps: the connection's (Chat & connections → Settings → Status emojis) and an agent's override (agent → Status emojis). The picker offers unicode emojis, Telegram's reaction set on a Telegram connection, and on Discord the server's own custom emojis, fetched with the bot token. The preview is resolved by AgEnD exactly as the bot will react.
- A change to a connection's `status_emojis` applies at the bot's next stamp, with no restart. Each agent's "avoid these" list follows at its next start. The rest of a connection (binding, access, token) still needs an AgEnD restart.
- `progress_prefix` is not a reaction: it is the emoji at the start of the progress message, so Telegram's reaction set does not limit it.

---

### defaults

All fields from `instances.<name>` can be set here as shared defaults. Additional defaults-only fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `startup.concurrency` | number | derived, `2`–`10` | Shared spawn-gate concurrency, based on free RAM and CPU count when omitted. An explicit value must be `1`–`20`. |
| `resume_interrupted_work` | boolean | `true` | After stable startup, continue eligible unfinished task work once, with pressure pacing. Unknown background inventory permits an advisory inspection prompt; known running background work or unknown session ownership holds it. An instance can override this to `false`; the journal remains enabled. Existing turn-resume behavior is unchanged in this stage. |
| `startup.stagger_delay_ms` | number | `500` | Minimum spacing between outer lifecycle admissions and standalone spawns (ms), shared by startup, wake, recovery and restart. At normal pressure, nested CLI spawns reuse the outer reservation and may coincide. Under elevated pressure, physical spawns remain serialized and at least 5 seconds apart; critical pressure holds new spawns. Valid range: `0`–`30000`. |
| `cost_guard.daily_limit_usd` | number | `0` (disabled) | Fleet-wide daily cost limit |
| `cost_guard.warn_at_percentage` | number | `80` | Warn threshold (% of limit) |
| `cost_guard.timezone` | string | system TZ | IANA timezone for daily reset |
| `hang_detector.enabled` | boolean | `true` | Enable stuck instance detection |
| `hang_detector.timeout_minutes` | number | `10` | Minutes of no output before alert |
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
| `reply_overdue_minutes` | number | `15` | Minutes since the last ask/reminder before notifying the requester once that a `requires_reply` request is unanswered and its owner is not working. `0` disables this idle-overdue notice, not owner reminders or the final TTL-expiration notice. |
| `reply_obligation_ttl_hours` | number | `24` | Positive finite hours since the last ask before an open reply obligation expires. Reminders do not extend it. Expiration is logged and tells the requester once if no overdue notice was already sent, even when `reply_overdue_minutes` is `0`. A restart sends one notice with up to ten open requests and `+N more`; turn-ended reminders keep their existing grace and one-per-ask behavior. |
| `retention_days` | number | `30` | How many days to keep terminal deliveries (`delivered`/`failed`) in `delivery-outbox.db` and `done`/`cancelled` tasks on the Task Board. `uncertain` and non-terminal rows are never pruned. Pruning runs once at fleet startup and daily after that, in chunks of 500 rows so it never stalls the event loop. A `delivery_status` query for a pruned delivery_id returns "older than the retention window; record pruned" instead of "Delivery not found". |
| `tips` | boolean | `true` | Daily General-topic tips. Independent of `daily_summary.enabled`. |
| `task_board.summary_at` | string | off | The task board's daily summary for the person (off unless set, since 2.3.0 — set a time to turn it on), in each platform's General and the web chat: `"HH:MM"` (24 h, in `scheduler.default_timezone`, else the host's zone) or `"off"`. Read at every minute's check (no restart). See [features](features.md#the-task-boards-daily-summary). |
| `locale` | `"en"` \| `"zh-TW"` | auto-detects from timezone | UI/notification language for user-facing text. Read when AgEnD starts: restart AgEnD after changing it. |

Restart deduplication keeps a separate owner/boot checkpoint (IDs and timestamp only), independent of notification retention. Cleaning old delivered notices does not allow the same boot to remind or stamp the requests again.

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
| `resume_interrupted_work` | boolean | inherited | Override automatic task-work continuation for this instance. `false` leaves interrupted work deferred and keeps journal observations. Takes effect without restarting the instance. |
| `auto_pause_after` | number | `0` (disabled) | Minutes idle before auto-pause. 0 = disabled. |
| `agent_mode` | `"mcp"` \| `"cli"` | `"mcp"` | Communication mode. `"mcp"` is the default for every backend, Antigravity included; `"cli"` opts into `agend-agent` HTTP commands |
| `tool_set` | string | `"worker"` | Tool profile: `"worker"` (the default — talk, read, do the work), `"coordinator"` (worker plus the verbs that run the fleet: create/delete/restart instances, teams, schedules), `"full"` (every tool), `"standard"` (30), `"minimal"` (9). Not user-settable: `"general"` (dispatcher profile) is assigned internally to General instances only — setting it by hand fails validation. |
| `tool_progress` | `"off"` \| `"standard"` \| `"verbose"` | `"off"` | Tool-activity detail shown in the channel's processing bubble. `standard` shows semantic labels with no shell arguments; `verbose` adds truncated command previews. Opt-in — the bubble broadcasts activity into the channel. |
| `cross_instance_visibility` | `"full"` \| `"summary"` \| `"hidden"` | `"full"` | How much of a bot-to-bot (cross-instance) message is posted in this instance's topic and web chat, on whichever side it is: `full` the whole message (as before), `summary` one line, `hidden` nothing. Set under `defaults` for the fleet (also with `/visibility`), here to override it for one instance; Settings has both. Applies at once, without a restart. Delivery and the Mirror Topic are never affected — see [features](features.md#bot-to-bot-message-visibility). |
| `dashboard` | object | all allowed | Which dashboard features this instance may use, on top of `tool_set`: `appearance` (its own look — theme, pictures, widgets, ambient, effects, mod proposals), `task_board` (the `task` tool) and `web_settings` (Settings → Look for the person). `false` switches one off: its tools are refused with the reason at each call (no restart) and leave the agent's tool list at once (its MCP server follows fleet.yaml); without the task board, an agent's instructions no longer tell it to use the board, and switching it back on sends the agent a notice. **A new fleet** (`agend init`, `agend quickstart`, the setup page) is written with `defaults.dashboard.task_board: false`: the task board is off until you set it to `true` (or remove the line), or tick it in Settings. An existing fleet.yaml is never rewritten. `defaults.dashboard` sets it for every instance; an instance's own merges key by key (`dashboard: { task_board: false }`). In Settings: an agent's dialog → Advanced → Dashboard access, and Agent defaults. Switching off applies at once; switching on is confirmed. |
| `board_cards_at_once` | number | `1` | How many task board cards handed to this instance it may have in progress at once; claiming another at the limit is refused. A whole number of at least 1. Cards the instance opened for itself never count. Raise it for a role that works on several handed-out cards (a reviewer). Read at each claim, so it applies at once. See [features](features.md#on-the-dashboard-fleet--tasks). |
| `effort` | string | — | Default reasoning effort for this instance (`low`/`medium`/`high`/`xhigh`/`max`, clamped per backend). Passed at every launch, a resumed one included, where the CLI takes it: `--effort` (claude-code, kiro-cli, antigravity), `--reasoning-effort` (grok, muse), `-c model_reasoning_effort` (codex). For claude-code, grok and antigravity, only when the installed version's `--help` lists the flag; kiro-cli uses its version check, and codex requires a level advertised by its model catalog. The level must be supported; otherwise the instance launches on the CLI's own setting and the Log tab says why. antigravity's model list has one model per level, so there the effort picks that level's model (`gemini-3.8-flash-medium` + `high` launches `gemini-3.8-flash-high`), and `--effort` never goes out with `--model`; a level the model lacks launches the configured model without it. Runtime override via the `/effort` command — see [commands.md](./commands.md). |
| `backend_options` | object | — | Per-backend options keyed by backend name, e.g. `{ codex: { provider: "glm" } }`. See **Credential profiles** below for `credential_profile`, and **Claude prompt-cache TTL** for `claude-code.prompt_cache_ttl`. |
| `terminal.enabled` | boolean | `true` | Logical terminal size feature toggle. `false` pins the window to tmux's historical 80x24 for compatibility. |
| `terminal.columns` | number | `120` | Terminal width when enabled; integer `80`–`300`. |
| `terminal.rows` | number | `36` | Terminal height when enabled; integer `24`–`120`. |
| `mcp_auto_restart` | boolean | `true` | Restart/resume when MCP dies or never connects within 90 seconds of CLI startup. Normally waits for idle, with a 30-minute forced-restart backstop; unresolved auth trouble suppresses automatic restart. `false` = notify only. |
| `mcp_proxy_reply` | boolean | `false` | Opt-in: when the MCP server is dead at end of turn and no reply was sent, the daemon relays the pane's final text to the channel (marked ⚠️ as proxy reply). Off by default — raw pane text can leak content redaction doesn't catch. |
| `reply_triggers` | boolean | `false` | Fleet-wide default for ClassicBot collab rooms: also accept native replies to this bot when enabled. Does not change fleet-topic admission. |
| `reply_completion_guard` | boolean | `true` | Bounded recovery when a human turn ends without a delivered reply. Requires backend support: Claude Code, successfully built Kiro legacy/TUI launches, Codex and Muse (only when the CLI's own log shows the turn ended); not Kiro v3 or other backends. Also configurable in Classic defaults/per-channel entries. |
| `lightweight` | boolean | `false` | Skip non-essential subsystems |
| `systemPrompt` | string | — | Additional instructions, inline or `file:path`, delivered through the native route below. A relative file path resolves under the instance's `working_directory`; several parts are joined with commas — see [features](features.md#systemprompt-file-paths). |
| `workflow` | string \| false | `"builtin"` | Workflow template: `"builtin"`, `"file:path"` (relative to the instance's `working_directory`), inline, or `false` |
| `skipPermissions` | boolean | effectively `true` unless `false` | Permission bypass uses backend-specific flags; see [security boundaries](SECURITY.md). OpenCode: launched with `--auto` when its `--help` lists it (explicit `deny` rules still apply); an older OpenCode gets no launch switch and its prompts are answered "Allow once" at runtime |
| `pre_task_command` | string | — | Raw command pasted before each user message |
| `startup_timeout_ms` | number | `25000` | CLI startup timeout (ms) |
| `log_level` | string | `"info"` | `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"` |
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
| Kiro CLI | The `prompt` of the instance's own agent, `.kiro/agents/agend-<instance>-<fleet>.json`; the steering file `.kiro/steering/agend-<instance>.md` on kiro-cli < 2.21 and for a resumed conversation (its switch to the instance's agent is suspended, #1800). On a resume AgEnD writes both files. A resumed conversation that was already saved as the instance's own agent reads the agent's `prompt`, not the steering file. |
| OpenCode | Instance `fleet-instructions.md` appended to the project's `opencode.json` `instructions` array |
| Antigravity | Managed marker block in workspace `.agents/AGENTS.md` |
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
`working_directory` (#1314; a file found only at the old fleet-directory location is still used, with a deprecation warning).

### Active Decisions

Fleet startup snapshots up to 20 active decisions, with each content capped at
200 characters. Each daemon selects relevant decisions; its instructions show up
to 15 summaries, each capped at 120 characters, and point to `list_decisions` for
more. This is a startup snapshot, not a live feed: use `list_decisions` for current
decisions, including ones posted after startup. It answers titles (id, title, scope, date, tags); pass `id` for one
decision's full text, or `full: true` for all of it (#2152).

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
| `auto_pause_after` | number | inherited | Idle minutes before pause; `0` disables |
| `tool_progress` | `off` \| `standard` \| `verbose` | inherited | Processing-bubble detail |
| `context_lines` | number | `5` | Chat history lines injected before each message (0 = disable) |
| `allowed_guilds` | string[] | `[]` | Discord server IDs granted new ClassicBot starts; empty/unset requests approval |
| `allowed_groups` | string[] | `[]` | Telegram group IDs granted access; empty/unset requests approval |
| `allowed_users` | string[] | `[]` | Telegram private user IDs granted new starts; empty/unset requests approval |
| `admin_users` | string[] | `[]` | Classic admin user IDs. Command gates differ by platform; see the [command surface matrix](command-surface.md). Classic Telegram `/raw` is currently blocked; hidden Fleet `/raw` requires the owning bot's F. |
| `reply_triggers` | boolean | inherited | ClassicBot default: channel → Classic defaults → `fleet.yaml` defaults → `false`. |
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
| `auto_pause_after` | number | inherited | Idle minutes before pause; `0` disables |
| `tool_progress` | `off` \| `standard` \| `verbose` | inherited | Processing-bubble detail |
| `backend_options` | object | merged defaults | Backend-specific options, including credential profiles |
| `display_name` / `description` | string | — | Agent display label and description |
| `web_echo` | boolean | unset: follows `web.echo_to_channel` (on) | Copy this ClassicBot room’s web chat to its platform chat; `false` keeps the room off |
| `reply_completion_guard` | boolean | inherited | Override the human reply guard for this Classic channel |
| `reply_triggers` | boolean | inherited | Override native-reply triggering for this collab room; explicit `false` overrides an enabled default. |
| `collab` | boolean | `false` | Collaboration mode (@mention trigger) |
| `pre_task_command` | string | — | Raw command pasted before each message |
| `createdBy` | string | — | User ID who created this channel |
| `createdAt` | string | — | ISO timestamp |

### Key behaviors

- **Backend fallback**: channel → `defaults.backend` → `fleet.yaml` defaults → `claude-code`
- **Hot reload**: changes detected every 30 seconds
- **Instance naming**: `classic-<sanitized-channel-name>-<last4-of-channelId>`, plus a sanitized adapter suffix on non-primary connections. A persisted `instanceName` wins; otherwise the display `name` (or channel ID), rather than an arbitrary YAML key, supplies the name.
- **DC auto-collab**: Discord `/start` auto-enables collab mode. By default, only an exact `<@bot>` mention in the sender’s own text triggers a turn. Enable `reply_triggers` to also accept a one-hop native reply to that bot; a reply to its message that itself answered a bot still does not trigger. Forward references and mentions inside forwarded content never count as addressing, regardless of this switch. Forwarded images remain available as context.
- **Reply-trigger Settings**: **Settings → Agent defaults** shows the fleet default (off); **Chat & connections → ClassicBot defaults** and each ClassicBot channel’s edit dialog show inherited effective values and overrides. Changes apply immediately without restarting agents. For example, `fleet.yaml` can set `defaults.reply_triggers: true`, while `classicBot.yaml` sets `channels.<key>.reply_triggers: false` to keep one room mention-only.
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

## Claude prompt-cache TTL

`backend_options.claude-code.prompt_cache_ttl` picks how long Claude Code asks the API to keep its prompt cache: `"1h"` or `"5m"`. Leave it unset, which is the default, and the CLI chooses for itself.

```yaml
instances:
  reviewer:
    backend: claude-code
    backend_options:
      claude-code:
        prompt_cache_ttl: "1h"
```

- **How it's passed:** AgEnD sets `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` to the value when it launches the instance. That covers the main conversation and its subagents.
- **When it takes effect:** on the instance's next start or restart.
- **What it costs:** a 1-hour cache write costs more than a 5-minute one (2× against 1.25× the base input price). It pays off only when an instance's idle gaps would otherwise expire the cache.
  - **Fleet → cache** shows how often its gaps outlast the TTL and what that costs.
  - For a 5-minute cache, it also shows what the cache really lasts (**Behaves as**). When the cache measurably expires in 5–60 minute gaps, the card recommends `"1h"`.
- **Billing modes:** an explicit value skips the CLI's own subscriber and extra-usage checks, so it applies whatever the account's billing. The limits below still apply.
- **Limits:**
  - It needs Claude Code 2.1.242 or later.
  - `FORCE_PROMPT_CACHING_5M=1` in the fleet's environment overrides it and keeps 5 minutes.
  - A 1-hour cache needs an API gateway or cloud provider that supports it. See Claude Code's [prompt-caching docs](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself).

## Credential profiles (multiple subscriptions of one backend)

For Kiro CLI, Codex and Claude Code, `backend_options.<backend>.credential_profile` selects a
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
isolate their stores. When a profile's sign-in expires, the alert names that
profile and its instances only, and gives the command that signs it in. With no effective profile after defaults inheritance, the
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

### Claude Code

Sign a profile in from chat (fleet admin):

```
/login claude-code work
```

This runs `claude auth login` for that profile in the same browser terminal
`/login claude-code` uses, so it works from a phone. On Discord, use `/login`
with `backend: claude-code` and `profile: work`. Or sign it in on the host:

```bash
CLAUDE_CONFIG_DIR=~/.agend/credential-profiles/claude-code/work claude auth login
```

After a successful sign-in, AgEnD wakes or restarts only the instances on that
login. A profile login leaves default-login instances alone, and the reverse.
Kiro and Codex profiles are still signed in on the host: `/login kiro-cli work`
answers with the exact command to run there.

A Claude Code profile is its own `CLAUDE_CONFIG_DIR`. The login, the account,
per-project trust, `settings.json` and every conversation (`projects/`, `sessions/`,
`history.jsonl`) belong to the profile. Your `CLAUDE.md`, `agents`, `commands`,
`skills`, `output-styles` and `plugins` are linked back to `~/.claude` (or your own
`CLAUDE_CONFIG_DIR`), so they stay the same everywhere. A new profile's
`settings.json` starts as a copy of yours (permissions, hooks, env, which plugins
are enabled); after that it is the profile's own, so a later change on either
side, such as `/model`, stays on that side.

Claude Code's auto-memory for a project (`projects/<repo>/memory/`) is shared the
same way: at each launch on a profile, the profile's memory folder for the
instance's repository (a git worktree counts as its main checkout) is linked to
the one under `~/.claude`, so every instance of that repository keeps one memory
whatever login it uses. Only the memory is shared; the conversations beside it
stay the profile's own. A profile memory folder that already holds notes is
never replaced: AgEnD leaves it as it is and logs a warning.

On macOS, claude keeps the login in the Keychain, under an item named after the
profile directory. Two profiles never share or overwrite each other's item, and
the default login is left alone.

If `update_instance_config` refused a switch, use `/login claude-code <profile>`
or run the command from its reply as it is: it carries the exact absolute path AgEnD launches with, and on macOS the
Keychain item is named after that path string.

An instance with no profile launches exactly as before: AgEnD sets no
`CLAUDE_CONFIG_DIR` (your own, if you set one, is still honoured) and creates
nothing. A fleet `ANTHROPIC_API_KEY` is passed only to an instance whose own
config directory has no claude.ai login, the same rule as before, applied to the
profile's directory.

**Switching a running Claude Code instance keeps its conversation** (#1753). Between the old CLI's stop and
the new one's start, AgEnD copies the session's transcript (`projects/<dir>/<session>.jsonl`), its folder and its
file history into the new profile, then dates the copy as the newest so the relaunch's `--continue` picks it.
- The old profile keeps its own copy, so switching back returns to the same conversation (with the turns added
  meanwhile).
- The next reply re-reads the conversation from a cold cache: one slower, full-price turn.
- The reply says `conversation_carried_over: true`.
- Settings and the login stay per profile; other transcripts in either profile are left as they are. Project auto-memory is shared as described above (an existing non-empty profile memory folder is preserved).

When the copy can't be made, the switch starts fresh with the same handover as Kiro, and the reply gives the reason in
`carry_failed`. That happens when there is no session yet, when the new profile already holds a different version of
that conversation, when there isn't enough free space, or when the copy fails.

### Seeing both quotas

`/usage`, `get_usage` and the dashboard show separate rows for effective
backend/profile bindings of running or paused instances. Active Kiro `work` and
`personal` profiles appear as `Kiro (work)` and `Kiro (personal)`; a shared-login
binding uses the default row. Sources used only by stopped or crashed instances
are filtered out.

Claude Code profiles get rows of their own too: `Claude (work)` reads the `work`
profile's own login (on macOS, its Keychain item), never the default one. When the
usage API cannot answer, a row falls back only to the rate limits that its own
instances' statuslines wrote. A profile that is not logged in shows "Not logged in"
with `/login claude-code <profile>` and the exact line that signs it in on the host,
and never another account's numbers. A fleet
without Claude profiles shows the one `Claude` row exactly as before.

Every Claude login on this host has a row, whether or not an instance runs on it (#2236): the default login
(`Claude (default)` beside profiles) and every profile under `credential-profiles/claude-code/`. A subscription at its
limit is usually the one nothing runs on any more, so it stays on screen, at 100% with its reset time, or saying the
usage endpoint rate-limited the request. A profile no instance uses and that is not logged in has no row. Two logins
signed in to the same account show as two rows (AgEnD cannot tell from the files which account a login really uses).
A Discord bot's activity status line still counts only the subscriptions its own running instances use.

An active Kiro profile without a readable login retains a signed-out hint.
Visibility also depends on the provider: Codex rows without OAuth usage
credentials, including API-key-only profiles, are omitted. Rows are not combined,
and different profile names do not guarantee different billing accounts.

### Web chat channel echo (2.2 web line)

Web chat echoes are enabled by default for fleet-topic instances. Set `web.echo_to_channel: false` to disable them, or use **Settings → Chat & connections → Web chat**. The copy goes to the instance's own Telegram or Discord topic as `🌐 web · <name>: …` (the web person's name, `web-user` when they have none — #1827), with attachment names and a note pointing to web chat for long text. It is display only: echoes never become a new agent turn. Web-only fleets are excluded. ClassicBot rooms echo too, group channels included: a room without `classicBot.yaml` → `channels.<key>.web_echo` follows `web.echo_to_channel` (so it is on by default and off when the fleet-wide switch is off); `web_echo: false` keeps one room off and `web_echo: true` keeps it on whatever the fleet-wide switch says (#2054). A failed echo is logged without failing or delaying web message delivery. Each echo has a five-second total ordering budget, including queue and admission waits. Replies proceed when the send settles or the budget expires. On expiry, queued copies are dropped with a warning; an already in-flight copy may land after the reply, and its late outcome is logged. No echo retry is attempted.

Echo text and attachment names replace mention/command tokens with visible ASCII labels such as `[mention: 200]`, `[at: botname]` and `[command: cmd at bot]`. Compatibility normalisation and format-character removal happen first; URLs, email local parts and ordinary path slashes remain intact. Discord also sends with `allowedMentions: { parse: [] }`; Telegram sends plain text without mention entities. The common ingress drops the fixed `🌐 web · ` prefix when its author is one of the configured fleet bot accounts on that platform, independent of echo flags or send acknowledgements. While any configured world on the same platform has an unknown bot identity, bot-flagged prefix candidates are also dropped before trigger evaluation, with a debug log. This temporary quarantine never affects human copies; after all identities are known, non-fleet bots keep the existing admission/collab rules. No unknown author is classified as a fleet bot, and no recent-message cache is used.

### Experimental Canvas Worker effects (#2275)

`web.experimental.canvas_worker` is a strict boolean, **`false` by default**:

```yaml
web:
  experimental:
    canvas_worker: false
```

A local fleet administrator can enable it in **Settings → Web dashboard → Experimental: Canvas Worker effects** (confirmation required). This setting cannot be changed over a public link or by a guest. It applies without restarting agents or reloading the dashboard.

While off, Canvas Worker controls, Try offers, posters, libraries and playback are hidden on local, public and guest pages. No Canvas Worker runtime modules or workers load. CW-only tools, including web mod export/proposal, disappear from agent tool lists and refuse direct calls; mixed appearance tools retain their non-CW options. Managed skills and agent notices omit CW instructions. Turning it off stops running CW effects. Saved workers, placements, preferences and mods remain on disk; enabling it restores them, subject to the existing consent and trust checks.

Ambient effects (falling petals, click stars and other data-only presets), themes, widgets and custom CSS are independent of this switch and keep working.

## Data directory permissions

AgEnD creates its home (`~/.agend`, or `AGEND_HOME`) with mode `0700`, including on hosts with umask `0002`.
If an existing real directory belongs to the current user and permits group/other writes, AgEnD tightens that
root to `0700` and logs one line. Existing files and non-writable roots are left unchanged. A foreign-owned home
or a path containing a symlink is refused; use a real directory owned by the account running AgEnD. The local
operator directory and sockets retain their separate private-permission checks. The live shell/WSL installer
prepares this boundary before running older releases' setup code too.
