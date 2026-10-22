---
title: Configuration
description: The fleet.yaml and classicBot.yaml reference.
---

AgEnD reads `~/.agend/fleet.yaml` (or `$AGEND_HOME/fleet.yaml`) at startup and on `agend reload`. Most of it can also be edited in the web dashboard's **Settings**. Validate before you start anything:

```bash
agend validate
```

This page is the short version. Every field, with the edge cases, is in the [full configuration reference](https://github.com/songsid/AgEnD/blob/main/docs/configuration.md) on GitHub.

## fleet.yaml

`instances` may be omitted; it defaults to an empty mapping.

| Field | Type | Default | What it does |
|---|---|---|---|
| `instances` | object | `{}` | Per-instance config, keyed by name |
| `channels` | ChannelConfig[] | — | Platform adapters, one per bot |
| `channel` | object | — | Single-channel form. Still works; Settings saves it as a `channels` list |
| `defaults` | object | `{}` | Applied to every instance |
| `project_roots` | string[] | — | Directories an agent may create instances in |
| `teams` | object | — | Named groups for targeted broadcasts |
| `templates` | object | — | Reusable multi-instance deployments |
| `profiles` | object | — | Reusable backend/model presets |
| `health_port` | number | `19280` | Port of the web dashboard and health endpoint, on `127.0.0.1` |
| `fleet_label` | string | host name | How this fleet names itself in `/login`, so several fleets' bots in one Discord server can be told apart |
| `web` | object | — | Web dashboard options, below |
| `web_terminal` | object | — | The browser terminal behind `/login`: `enabled` (`true`), `bind` (`127.0.0.1`), `ttl_minutes` (1–20, `10`), and `tunnel.allow_public` |
| `needs_you` | object | — | The **Needs you** list of things waiting on a person: `live_message` (`true`) keeps one live message in General; `dm` (`false`) also DMs the bot's admins; `task_board` (`false`) adds the Task Board cards that wait on you |

### web

The most used keys. The [full reference](https://github.com/songsid/AgEnD/blob/main/docs/configuration.md#top-level-fields) lists the rest.

| Key | Default | What it does |
|---|---|---|
| `web.usage_panel` | `true` | `false` hides subscription usage everywhere and disables `/api/ai-usage` |
| `web.log_tab` | `false` | Turns on each instance's **Log** tab. For Claude Code and Codex it shows the prompts, replies, tool calls and errors from the agent's transcript, secrets masked. Other backends (Kiro included) show fleet events only, with the reason |
| `web.allowed_hosts` | — | Extra `Host` names the dashboard answers to behind a reverse proxy or port forward. Any other `Host` gets 403 |
| `web.view_access` | `open` | `session` closes `/view` to anyone not signed in |
| `web.notify_login` | `true` | `false` stops General being told about each local web sign-in |
| `web.session.local.absolute_hours` / `.idle_hours` | `48` / `48` | How long a sign-in on the directly reached dashboard lasts (up to 720). A public-link session is fixed at 4 h / 30 min idle |
| `web.preview` | `true` | `false` turns off HTML previews in web chat |
| `web.public_link.allow_public` | `true` | `false` removes the temporary public link from `/web` and closes one already open |
| `web.public_link.ttl_minutes` | `120` | Lifetime of a public link: 1–480 on a quick tunnel; 1–10080, or `0` for no expiry, with your own domain |
| `web.public_link.hostname` | — | Your own domain for a named Cloudflare tunnel. The link keeps the same address each time. The tunnel token is set in Settings and never shown back |
| `web.public_link.auto_open` | `false` | With your own domain: reopen the public link after a fleet restart, for the admin who opened it last |
| `web.verified_authority.named_link` | `false` | Lets a browser you have verified act with your account, through your own domain only. A quick tunnel never qualifies |
| `web.search.retention_days` | `90` | How many days the global search (Ctrl+K) keeps its index of messages and tasks (1–3650) |
| `web.experimental.canvas_worker` | `false` | Turns on Canvas Worker effects (uploaded effects that run in an isolated worker). Experimental; the built-in ambient effects are not affected |
| `web.echo_to_channel` | `true` | `false` stops copying web chat messages into the instance's Telegram or Discord topic |

See the [web dashboard guide](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.md) for signing in, sessions and the public link.

### channels

One entry per bot.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `type` | string | yes | — | `telegram` or `discord` |
| `mode` | string | no | `topic` | Must be `topic` |
| `bot_token_env` | string | yes | — | Name of the env var holding the token |
| `id` | string | with several channels | type value | Unique id, e.g. `telegram`, `discord` |
| `group_id` | number \| string | no | — | Telegram forum group, or Discord server (guild) |
| `access` | AccessConfig | no | open, see below | Who may talk to it |
| `options` | object | no | — | Platform-specific, below |
| `telegram_api_root` | string | no | `https://api.telegram.org` | Override the Bot API URL |
| `mirror_topic_id` | number \| string | no | — | Topic that mirrors cross-instance messages |

The token itself never goes in the file. `bot_token_env` names the variable in `~/.agend/.env` to read it from.

#### access

**Leaving out the whole `access` block lets everyone in** (`open`). `agend quickstart` writes `mode: locked` with your user ID. An `access` block you write is not filled in field by field, so set `mode` and `allowed_users` yourself.

| Field | Type | When the block is left out | What it does |
|---|---|---|---|
| `mode` | `locked` \| `pairing` \| `open` | `open` | `locked` = the allow list only. `pairing` = the allow list, plus self-registration with `/pair`. `open` = anyone |
| `allowed_users` | (number\|string)[] | `[]` | User IDs allowed in |
| `max_pending_codes` | number | `0` | Distinct users with pending pairing codes (up to two codes per user). Set a positive number for `pairing` |
| `code_expiry_minutes` | number | `0` | Pairing code lifetime. Set a positive number for `pairing` |

- **The saved state wins over `fleet.yaml`.** Pairing, confirming a code, or `agend access lock`/`unlock` writes the mode to `~/.agend/access/access.json` (`access-<id>.json` for other bots). From then on the saved mode is used, and the saved users are added to `allowed_users`. To take someone out, remove them from both.
- **Fleet admin is separate.** Admin commands (`/update`, `/login`, `/web`, …) need the user in that bot's `allowed_users` in `fleet.yaml`. `open` access or a pairing does not make anyone an admin.

#### options

Discord takes `general_channel_id`, the channel the General instance answers in.

Telegram takes:
- `topic_probe`: `on-demand` by default, so a topic is only checked after a real delivery reports it missing. `periodic` also probes every bound topic on the 5-minute scan, which posts and deletes a blank message in each one.
- `sticker_sets`: the sticker sets `list_stickers` shows when an agent names none.

Both take `status_emojis`, the reactions the bot stamps on your messages (`received`, `queued`, `processing`, `delivered`, `failed`, …). Unset keys keep the built-in ones. Telegram accepts only its own reaction set. **Settings** has a picker for them.

### defaults

Every `instances.<name>` field can be set here. These are defaults-only:

| Field | Type | Default | What it does |
|---|---|---|---|
| `locale` | `en` \| `zh-TW` | `zh-TW` on a host at UTC+8, else `en` | Language of user-facing text, including the CLI's messages. The machine-read lines stay in English |
| `warm_cap` | number | `0` (unlimited) | Cap on instances running at once. Over the cap, the least recently active idle instance is paused. General is never paused for it |
| `delivery_worker` | `off` \| `wake_only` \| `on` | `wake_only` | `wake_only` wakes a paused instance when work from another instance is queued for it. `off` never does. `on` (canary) also gives it a delivery worker of its own |
| `warm_overflow` | number | `2` | How far `warm_cap` may be exceeded to wake an instance with queued work |
| `max_cross_instance_message_bytes` | number | `12288` | Largest cross-instance message body. Bigger ones are refused with advice to send a file path |
| `reply_overdue_minutes` | number | `15` | Tell the asker once when a request that needs a reply is unanswered and its owner is idle. `0` turns this notice off |
| `reply_obligation_ttl_hours` | number | `24` | Hours after which an unanswered request expires |
| `retention_days` | number | `30` | How long finished deliveries and done Task Board tasks are kept |
| `task_board.summary_at` | `"HH:MM"` or `"off"` | `off` | When the daily Task Board summary is sent, in the fleet's timezone (24 h). Off until you set a time |
| `dashboard` | object | — | Which dashboard features an agent may use: `appearance`, `task_board`, `web_settings`. `false` switches one off. New fleets get `task_board: false` |
| `progress_min_elapsed` | number | `30` | Seconds before the live-progress line starts showing elapsed time |
| `startup.concurrency` | number | from RAM and CPUs, `2`–`10` | Instances starting at once (`1`–`20` when set) |
| `startup.stagger_delay_ms` | number | `500` | Minimum gap between two instance starts, for startup, wake and restart alike |
| `cost_guard.daily_limit_usd` | number | `0` (off) | Fleet-wide daily spend limit |
| `cost_guard.warn_at_percentage` | number | `80` | Warn at this share of the limit |
| `cost_guard.timezone` | string | system | IANA zone the daily reset follows |
| `hang_detector.enabled` | boolean | `true` | Detect stuck instances |
| `hang_detector.timeout_minutes` | number | `10` | Minutes a working instance's screen may stay unchanged before alerting |
| `daily_summary.enabled` | boolean | `true` | Daily cost and status report |
| `daily_summary.hour` / `.minute` | number | `21` / `0` | When it is sent, local time |
| `tips` | boolean | `true` | Daily tips in General |
| `scheduler.max_schedules` | number | `100` | Schedule limit |
| `scheduler.default_timezone` | string | `Asia/Taipei` | Time zone of schedules that name none |
| `scheduler.retry_count` / `.retry_interval_ms` | number | `3` / `30000` | Retries of a failed scheduled delivery |
| `webhooks` | WebhookConfig[] | — | Outbound notifications |

### instances

```yaml
instances:
  myproject:
    working_directory: /home/you/projects/app
    backend: claude-code
    model: sonnet
    effort: high
```

| Field | Type | Default | What it does |
|---|---|---|---|
| `working_directory` | string | auto-created | Absolute path to the project |
| `backend` | string | `claude-code` | `claude-code`, `codex`, `opencode`, `kiro-cli`, `antigravity`, `grok`, `muse` |
| `model` | string | — | Model override; format follows the backend |
| `model_failover` | string[] | — | Models to fall back to, in order, on a rate limit |
| `effort` | string | — | `low`/`medium`/`high`/`xhigh`/`max`. Passed at every launch where the installed CLI takes it, clamped to what it accepts. Otherwise the CLI's own setting is used and the Log tab says why. `/effort` changes it from chat |
| `display_name` | string | — | Name the agent shows under |
| `description` | string | — | What this agent is for |
| `tags` | string[] | — | Capability tags, used for discovery |
| `topic_id` | number \| string | auto-created | Telegram topic or Discord thread |
| `channel_id` | string | — | Which channel adapter (bot) it belongs to |
| `general_topic` | boolean | `false` | Mark as the General dispatcher |
| `tool_set` | string | `worker` | See [Tool profiles](#tool-profiles) |
| `tool_progress` | `off` \| `standard` \| `verbose` | `off` | Tool activity shown in the channel. `verbose` adds truncated command previews |
| `cross_instance_visibility` | `full` \| `summary` \| `hidden` | `full` | How much of a bot-to-bot message is posted in this instance's topic and web chat. Delivery is never affected. Also `/visibility` |
| `status_emojis` | object | — | This instance's own status reactions, over the channel's |
| `auto_pause_after` | number | `0` (off) | Minutes idle before pausing |
| `backend_options` | object | — | Per-backend settings, keyed by backend name. See [Credential profiles](#credential-profiles) |
| `terminal.enabled` | boolean | `true` | `false` pins the window to 80x24 |
| `terminal.columns` / `.rows` | number | `120` / `36` | Terminal size |
| `mcp_auto_restart` | boolean | `true` | Restart the instance when its MCP server dies or never connects. `false` only notifies |
| `mcp_proxy_reply` | boolean | `false` | Relay the pane's final text when the MCP server died mid-turn. Off because raw pane text can leak what redaction misses |
| `reply_completion_guard` | boolean | `true` | Recover when a turn from a person ends without a reply (Claude Code, Kiro legacy/TUI, Codex, Muse) |
| `systemPrompt` | string | — | Extra instructions, inline or `file:path` (relative to `working_directory`) |
| `workflow` | string \| false | `builtin` | `builtin`, `file:path`, inline text, or `false` |
| `pre_task_command` | string | — | Pasted before every user message |
| `skipPermissions` | boolean | `true` unless `false` | Skip the CLI's own permission prompts, with each backend's flag. Antigravity always launches with `--dangerously-skip-permissions`, even with `false` |
| `startup_timeout_ms` | number | `25000` | How long the CLI gets to come up |
| `log_level` | string | `info` | `trace`, `debug`, `info`, `warn`, `error` |
| `lightweight` | boolean | `false` | Skip non-essential subsystems |
| `agent_mode` | `mcp` \| `cli` | `mcp` | `cli` uses `agend-agent` commands instead of MCP |
| `kiro_ui` | `legacy` \| `tui` | `legacy` | Kiro engine, pinned on every launch (`v3` is refused until it can run unattended) |
| `worktree_source` | string | — | The original repo, when this is a git worktree |
| `cost_guard` | CostGuardConfig | — | Per-instance limit, overrides the fleet one |
| `restart_policy.max_retries` | number | `10` | Crash restarts before giving up |
| `restart_policy.backoff` | string | `exponential` | `exponential` or `linear` |
| `restart_policy.reset_after` | number | `300` | Seconds of uptime that clear the retry count |

`context_guardian.max_age_hours` and `context_guardian.grace_period_ms` are ignored now, with a validation warning: AgEnD no longer rotates sessions, and each CLI compacts its own context.

### Tool profiles

`tool_set` decides what an agent may do. It is enforced by the fleet, not by what the model was shown. It is a policy, not isolation: agents running as the same OS user can still reach each other's files.

| Profile | How you get it | What it is |
|---|---|---|
| `worker` | the default | Talk to people and peers, read the fleet, do the work, and schedule for itself |
| `coordinator` | `tool_set: coordinator` | Worker, plus the verbs that run the fleet: create, delete, restart instances, teams, and schedules for other instances |
| `full` | `tool_set: full` | Every tool |
| `standard` / `minimal` | set by hand | 30 tools / 9 tools |

`general` is assigned to General instances and cannot be set by hand: writing it fails validation.

### teams

```yaml
teams:
  reviewers:
    description: Code review team
    members: [reviewer-a, reviewer-b]
```

### templates

A template deploys several instances at once. Supply `branch` for a worktree per role; without it, a second role in the same directory is refused and deployment rolls back.

```yaml
templates:
  sprint-team:
    description: Sprint development team
    team: true
    instances:
      dev:
        backend: claude-code
        model: sonnet
      reviewer:
        backend: kiro-cli
        tool_set: minimal
```

`team: true` also creates a team from whatever it deployed. A template instance takes `description`, `backend`, `model`, `model_failover`, `tool_set`, `systemPrompt`, `skipPermissions`, `lightweight`, `workflow`, `tags` and `profile`.

Deployment is done by agents through the `deploy_template`, `teardown_deployment` and `list_deployments` tools. There is no CLI command for it.

### profiles

Presets a template instance can name with `profile: <name>`:

```yaml
profiles:
  heavy:
    backend: claude-code
    model: opus
  light:
    backend: kiro-cli
    lightweight: true
```

### webhooks

```yaml
defaults:
  webhooks:
    - url: https://example.com/hook
      events: [cost_warning, hang]
      headers:
        Authorization: "Bearer token"
```

The events sent are `hang`, `mcp_died`, `pty_error`, `pty_recovered`, `cost_warning`, `cost_limit`, `schedule_deferred`, `model_failover` and `model_recovered`. `events: ["*"]` subscribes to all of them.

## Credential profiles

A CLI backend keeps its login in one place, so every instance shares one account. For **Kiro CLI, Codex and Claude Code**, `credential_profile` gives an instance a named, separate login. Other backends ignore it, with a warning.

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

Instances naming the same profile share a login. An instance without its own `credential_profile` inherits the fleet default. Only an effective empty/unset profile uses the shared login without creating a profile directory. Profiles live under `~/.agend/credential-profiles/<backend>/<profile>`.

Log a profile in once:

| Backend | How |
|---|---|
| Claude Code | `/login claude-code work` from chat (works from a phone), or on the host: `CLAUDE_CONFIG_DIR=~/.agend/credential-profiles/claude-code/work claude auth login` |
| Kiro CLI | On the host: `XDG_DATA_HOME=~/.agend/credential-profiles/kiro-cli/work kiro-cli login` |
| Codex | On the host: `CODEX_HOME=~/.agend/credential-profiles/codex/work codex login` |

To move an existing agent, ask General in plain language, for example "move research-a to the personal subscription". AgEnD changes the config and restarts a running agent; a paused/stopped agent uses it on the next start. **A config change that switches to a profile that was never logged in is refused**,  and the error carries the command that logs it in. `credential_profile: null` clears the agent's own setting, so it follows the fleet default again (normally the shared login). Going back to the shared login is never refused.

What a switch does to the conversation depends on the backend:
- **Claude Code** keeps it: AgEnD copies the session into the new profile during the restart, and the old profile keeps its own copy. If the copy can't be made, it starts fresh as Kiro does, and says why.
- **Kiro** starts a new one, because kiro keeps conversations beside the login. AgEnD hands the new session the recent messages instead.
- **Codex** shares its conversation stores across profiles; only the login changes.

For Kiro, only the login is duplicated: the large runtimes kiro downloads link back to the shared copy, so a second profile costs megabytes. A new Kiro profile starts without `knowledge_bases` and shell history; copy them across by hand if you want them in both.

`/usage` and the dashboard show a separate row per profile in use, such as `Kiro (work)` or `Claude (work)`. The [full reference](https://github.com/songsid/AgEnD/blob/main/docs/configuration.md#credential-profiles-multiple-subscriptions-of-one-backend) covers what each backend shares and what it keeps per profile.

## classicBot.yaml

`~/.agend/classicBot.yaml` manages ClassicBot channels (an agent attached to any channel with `/start`). `agend quickstart` offers to create it for Discord; otherwise it is created on the first `/start`. Changes are detected every 30 seconds. Launch settings restart running agents; supported runtime settings update in place.

### defaults

| Field | Type | Default | What it does |
|---|---|---|---|
| `backend` | string | `claude-code` | Backend for classic channels |
| `model` | string | — | Model for classic channels |
| `context_lines` | number | `5` | Chat history lines injected before each message. `0` disables |
| `allowed_guilds` | string[] | `[]` | Discord servers allowed to start ClassicBot |
| `allowed_groups` | string[] | `[]` | Telegram groups allowed |
| `allowed_users` | string[] | `[]` | Telegram users allowed in a private chat |
| `admin_users` | string[] | `[]` | ClassicBot admins. They may start in a new room without the allow lists; the [command surface](https://github.com/songsid/AgEnD/blob/main/docs/command-surface.md) lists what else needs one |
| `auto_pause_after` | number | inherited | Idle minutes before pause; `0` disables |
| `tool_progress` | `off` \| `standard` \| `verbose` | inherited | Processing-bubble detail |
| `reply_completion_guard` | boolean | inherited | As the instance field of the same name |

**An empty allow list does not mean open.** When someone who is not a ClassicBot admin runs `/start` in a new room whose server, group or private chat is not on a list, General is asked for approval, with **Allow / Allow+admin / Ignore** buttons. Approving does not start the agent: run `/start` again. Admins skip this, and rooms already registered keep working.

In a Telegram group, only a ClassicBot admin can start an agent, even once the group is allowed. **Allow** grants just the group; use **Allow+admin**, or have an admin run `/start`.

In a Telegram group, address the bot: `/start@YourBot` (or `/start@YourBot codex`). A group command without `@YourBot` is ignored.

### channels

```yaml
channels:
  "1234567890":
    name: dev-help
    backend: kiro-cli
```

| Field | Type | Default | What it does |
|---|---|---|---|
| `name` | string | — | Display name |
| `backend` / `model` | string | from defaults | Override for this channel |
| `context_lines` | number | from defaults | Override for this channel |
| `collab` | boolean | `false` | Discord: keep every message in the channel as context. A turn still needs an @mention of the bot, or `/chat`. Don't set it on Telegram, see below |
| `auto_pause_after` / `tool_progress` | as above | inherited | Per-channel overrides |
| `backend_options` | object | merged defaults | Backend-specific options and credential profile |
| `display_name` / `description` | string | — | Agent label and description |
| `web_echo` | boolean | `false` | Copy this room’s web chat to the platform, independent of `web.echo_to_channel` |
| `pre_task_command` | string | — | Pasted before every message |
| `reply_completion_guard` | boolean | from defaults | Override for this channel |

On Telegram, a `collab: true` written into the file makes the bot wait for a Discord-style mention, so ordinary messages can go unanswered. A normal Telegram `/start` never sets it.

Backend resolution order: channel → `defaults.backend` → `fleet.yaml` defaults → `claude-code`.

Instances are named `classic-<channel-name>-<last4-of-channel-id>`. Discord `/start` turns on collab mode automatically.
