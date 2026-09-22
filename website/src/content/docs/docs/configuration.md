---
title: Configuration
description: The fleet.yaml and classicBot.yaml reference.
---

AgEnD reads `~/.agend/fleet.yaml` at startup and on `agend reload`. Validate before you start anything:

```bash
agend validate
```

## fleet.yaml

Only `instances` is required.

| Field | Type | Default | What it does |
|---|---|---|---|
| `instances` | object | — | **Required.** Per-instance config, keyed by name |
| `channels` | ChannelConfig[] | — | Platform adapters. Use this, not `channel` |
| `channel` | object | — | Single-channel form. Legacy |
| `defaults` | object | `{}` | Applied to every instance |
| `project_roots` | string[] | — | Directories an agent may create instances in |
| `teams` | object | — | Named groups for targeted broadcasts |
| `templates` | object | — | Reusable multi-instance deployments |
| `profiles` | object | — | Reusable backend/model presets |
| `health_port` | number | `19280` | HTTP health endpoint |
| `web.usage_panel` | boolean | `true` | `false` hides the subscription usage panel and disables `/api/ai-usage` |

### channels

One entry per platform adapter.

| Field | Type | Required | Default | What it does |
|---|---|---|---|---|
| `type` | string | yes | — | `telegram` or `discord` |
| `mode` | string | yes | — | Must be `topic` |
| `bot_token_env` | string | yes | — | Name of the env var holding the token |
| `access` | AccessConfig | yes | — | Who may talk to it |
| `id` | string | multi-channel | type value | Unique id, e.g. `telegram`, `discord` |
| `group_id` | number \| string | no | — | Telegram forum group, or Discord guild |
| `options` | object | no | — | Platform-specific, below |
| `telegram_api_root` | string | no | `https://api.telegram.org` | Override the Bot API URL |
| `mirror_topic_id` | number \| string | no | — | Topic that mirrors cross-instance messages |

The token itself never goes in the file — `bot_token_env` names the variable to read it from.

#### access

| Field | Type | Default | What it does |
|---|---|---|---|
| `mode` | `locked` \| `pairing` \| `open` | `locked` | `locked` = whitelist only. `pairing` = self-register with `/pair`. `open` = anyone, including bots |
| `allowed_users` | (number\|string)[] | `[]` | Whitelisted user ids |
| `max_pending_codes` | number | `3` | Simultaneous pairing codes |
| `code_expiry_minutes` | number | `10` | Pairing code lifetime |

`open` lets bot messages reach fleet topics directly. Use it deliberately.

**`mode` is remembered once anyone pairs.** Pairing, confirming a code, or `agend access lock`/`unlock` writes the current mode to `~/.agend/access/access.json` (or `access-<adapter-id>.json`), and the file wins over `fleet.yaml` from then on — a pairing done at runtime has to survive a restart. So an edit to `access.mode` after that point changes nothing. The fleet says so in the log at startup, and names the file; delete it to go back to the configured value.

#### options

Discord takes `general_channel_id` — the channel the General instance answers in.

Telegram takes `topic_probe`, which is `on-demand` by default: a topic is only checked after a real delivery reports it missing. Set it to `periodic` to also probe every bound topic on the 5-minute scan, which posts and deletes a blank message in each one.

### defaults

Every `instances.<name>` field can be set here. These are defaults-only:

| Field | Type | Default | What it does |
|---|---|---|---|
| `locale` | `en` \| `zh-TW` | from timezone | Language of user-facing text |
| `warm_cap` | number | `0` (unlimited) | Cap on simultaneously running instances. Over the cap, the least-recently-active idle instance is paused. General instances are never evicted |
| `max_cross_instance_message_bytes` | number | `12288` | Largest cross-instance message body. Oversized ones are rejected with advice to send a file path instead |
| `progress_min_elapsed` | number | `30` | Seconds before the live-progress line starts showing elapsed time |
| `startup.concurrency` | number | `10` | Instances starting at once |
| `startup.stagger_delay_ms` | number | `500` | Gap between startup groups |
| `cost_guard.daily_limit_usd` | number | `0` (off) | Fleet-wide daily spend limit |
| `cost_guard.warn_at_percentage` | number | `80` | Warn at this share of the limit |
| `cost_guard.timezone` | string | system | IANA zone the daily reset follows |
| `hang_detector.enabled` | boolean | `true` | Detect stuck instances |
| `hang_detector.timeout_minutes` | number | `15` | Minutes of silence before alerting |
| `daily_summary.enabled` | boolean | `true` | Daily cost and status report |
| `daily_summary.hour` / `.minute` | number | `21` / `0` | When it is sent, local time |
| `scheduler.*` | — | — | `max_schedules`, `default_timezone`, `retry_count`, `retry_interval_ms` |
| `webhooks` | WebhookConfig[] | — | Outbound notifications |

### instances

```yaml
instances:
  myproject:
    working_directory: /home/you/projects/app
    backend: claude-code
    model: sonnet
```

| Field | Type | Default | What it does |
|---|---|---|---|
| `working_directory` | string | auto-created | Absolute path to the project |
| `backend` | string | `claude-code` | `claude-code`, `codex`, `opencode`, `kiro-cli`, `antigravity`, `grok`, `muse`, `gemini-cli` (deprecated) |
| `model` | string | — | Model override; format follows the backend |
| `model_failover` | string[] | — | Models to fall back to, in order, on a rate limit |
| `effort` | string | — | `low`/`medium`/`high`/`xhigh`/`max`, clamped to what the backend accepts |
| `display_name` | string | — | Name the agent shows under |
| `description` | string | — | What this agent is for |
| `tags` | string[] | — | Capability tags, used for discovery |
| `topic_id` | number \| string | auto-created | Telegram topic or Discord thread |
| `channel_id` | string | — | Which channel adapter it belongs to |
| `general_topic` | boolean | `false` | Mark as the General dispatcher |
| `tool_set` | string | `worker` | See [Tool profiles](#tool-profiles) |
| `tool_progress` | `off` \| `standard` \| `verbose` | `off` | Tool detail shown in the channel. `verbose` adds truncated command previews |
| `auto_pause_after` | number | `0` (off) | Minutes idle before pausing |
| `backend_options` | object | — | Per-backend settings, keyed by backend name |
| `terminal.enabled` | boolean | `true` | `false` pins the window to 80x24 |
| `terminal.columns` / `.rows` | number | `120` / `36` | Terminal size |
| `mcp_auto_restart` | boolean | `true` | Restart the instance when its MCP server dies. `false` only notifies |
| `mcp_proxy_reply` | boolean | `false` | Relay the pane's final text when the MCP server died mid-turn. Off because raw pane text can leak what redaction misses |
| `systemPrompt` | string | — | Custom prompt; `file:path` is accepted |
| `workflow` | string \| false | `builtin` | `builtin`, `file:path`, inline text, or `false` |
| `pre_task_command` | string | — | Pasted before every user message |
| `skipPermissions` | boolean | — | Skip the CLI's own permission checks |
| `startup_timeout_ms` | number | `25000` | How long the CLI gets to come up |
| `log_level` | string | `info` | `debug`, `info`, `warn`, `error` |
| `lightweight` | boolean | `false` | Skip non-essential subsystems |
| `agent_mode` | `mcp` \| `cli` | `mcp` | `cli` for antigravity |
| `kiro_ui` | `legacy` \| `tui` \| `v3` | `legacy` | Kiro launch mode |
| `worktree_source` | string | — | The original repo, when this is a git worktree |
| `cost_guard` | CostGuardConfig | — | Per-instance limit, overrides the fleet one |
| `restart_policy.max_retries` | number | `10` | Crash restarts before giving up |
| `restart_policy.backoff` | string | `exponential` | `exponential` or `linear` |
| `restart_policy.reset_after` | number | `300` | Seconds of uptime that clear the retry count |
| `context_guardian.max_age_hours` | number | `0` (off) | Force a session rotation after N hours |
| `context_guardian.grace_period_ms` | number | `600000` | Wait before rotating |

### Tool profiles

`tool_set` decides what an agent may do. It is enforced by the fleet, not by what the model was shown.

| Profile | How you get it | What it is |
|---|---|---|
| `worker` | the default | Talk to people and peers, read the fleet, do the work |
| `coordinator` | `tool_set: coordinator` | Worker, plus the verbs that run the fleet: create, delete, restart instances, teams, schedules |
| `full` | `tool_set: full` | Every tool |
| `standard` / `minimal` | set by hand | 18 tools / 4 tools |

`general` is assigned to General instances and cannot be set by hand — writing it fails validation.

### teams

```yaml
teams:
  reviewers:
    description: Code review team
    members: [reviewer-a, reviewer-b]
```

### templates

A template deploys several instances at once, each in its own git worktree.

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

`team: true` also creates a team from whatever it deployed. Instances take the same fields as `instances.<name>`.

Deployment is done by agents through the `deploy_template`, `teardown_deployment` and `list_deployments` tools — there is no CLI command for it.

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
      events: [instance.started, instance.stopped]
      headers:
        Authorization: "Bearer token"
```

## Credential profiles

A CLI backend keeps its login in one place, so every instance shares one account. `credential_profile` gives a named, separate copy of that place.

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

Instances naming the same profile share a login. An instance with no `credential_profile` is untouched — nothing is added to its launch and no directory is created for it.

Log a profile in once, from the host:

```bash
XDG_DATA_HOME=~/.agend/credential-profiles/kiro-cli/work kiro-cli login
```

Profiles live under `~/.agend/credential-profiles/<backend>/<profile>`, beside the fleet rather than inside an instance, so several agents can point at one subscription.

Only the login is duplicated. The multi-gigabyte runtimes kiro downloads are symlinked back to the shared copy, so a second profile costs megabytes.

**A profile starts empty apart from those caches.** Anything the backend keeps beside its login — kiro's `knowledge_bases`, its shell history — belongs to the profile, so an agent moved to a new profile starts without it. Copy `knowledge_bases` across by hand if you want it in both.

Switching an existing agent is a config change plus a restart, and AgEnD does the restart for you. Ask General in plain language — "move research-a to the personal subscription". Send `credential_profile: null` to put an agent back on the default login.

**Switching to a profile that was never logged in is refused**, and the error carries the command to log it in. Going back to the default login is never refused — that is the way out of a bad switch.

### Switching is a new conversation

kiro keeps conversations in the same database as the login, so a different subscription is a different set of conversations and there is nothing to resume. AgEnD does not try: the first launch after a switch skips resume outright.

What carries across is the intent. AgEnD takes the outgoing session's recent messages and activity from the daemon — not from the CLI's store — and delivers them to the new session as a handover that says which subscription it came from and that the conversation did not come with it.

## classicBot.yaml

`~/.agend/classicBot.yaml` manages ClassicBot channels, and is created on the first `/start`. Changes are picked up every 30 seconds; no restart needed.

### defaults

| Field | Type | Default | What it does |
|---|---|---|---|
| `backend` | string | `claude-code` | Backend for classic channels |
| `model` | string | — | Model for classic channels |
| `context_lines` | number | `50` | Chat history lines injected before each message. `0` disables |
| `allowed_guilds` | string[] | `[]` | Discord servers allowed to use ClassicBot. Empty = all |
| `allowed_groups` | string[] | `[]` | Telegram groups allowed |
| `allowed_users` | string[] | `[]` | Users allowed to interact |
| `admin_users` | string[] | `[]` | Users who may run `/start`, `/stop`, `/raw`, `/compact`, `/save`, `/load`, `/collab` |

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
| `collab` | boolean | `false` | Respond without an @mention |
| `pre_task_command` | string | — | Pasted before every message |

Backend resolution order: channel → `defaults.backend` → `fleet.yaml` defaults → `claude-code`.

Instances are named `classic-<channel-name>-<last4-of-channel-id>`. Discord `/start` turns on collab mode automatically.
