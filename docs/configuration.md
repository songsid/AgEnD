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

---

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

---

### instances.\<name\>

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `working_directory` | string | auto-created | Absolute path to project directory |
| `display_name` | string | — | Agent display name (set by agent) |
| `description` | string | — | Human-readable role description |
| `tags` | string[] | — | Capability tags for discovery |
| `topic_id` | number \| string | auto-created | Telegram topic ID or Discord thread ID |
| `channel_id` | string | — | Bound channel adapter ID (for multi-channel) |
| `general_topic` | boolean | `false` | Mark as General dispatcher instance |
| `backend` | string | `"claude-code"` | CLI backend: `claude-code`, `codex`, `opencode`, `kiro-cli`, `antigravity`, `grok` (⚠️ experimental), `gemini-cli` (⚠️ deprecated) |
| `model` | string | — | Model override (format depends on backend) |
| `model_failover` | string[] | — | Ordered fallback models on rate limit |
| `agent_mode` | `"mcp"` \| `"cli"` | `"mcp"` | Communication mode (`"cli"` for antigravity) |
| `tool_set` | string | `"full"` | MCP tool profile: `"full"` (20), `"standard"` (8), `"minimal"` (3) |
| `lightweight` | boolean | `false` | Skip non-essential subsystems |
| `systemPrompt` | string | — | Custom system prompt (supports `file:path` syntax) |
| `workflow` | string \| false | `"builtin"` | Workflow template: `"builtin"`, `"file:path"`, inline, or `false` |
| `skipPermissions` | boolean | — | Skip CLI permission checks |
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
