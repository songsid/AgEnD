---
name: fleet-config
description: fleet.yaml and classicBot.yaml structure, access modes, validation, common mistakes
roles: [general]
---

## Configuration Quick Reference

**fleet.yaml structure:**
```yaml
channel:          # Telegram/Discord connection
defaults:         # Shared defaults for all instances
  backend: kiro-cli
  startup:
    concurrency: 6        # Max simultaneous instance startups
    stagger_delay_ms: 2000  # Delay between startup batches
instances:        # Per-instance config (topic_id, working_directory, etc.)
templates:        # Reusable fleet deployment templates
```

**classicBot.yaml** — manages classic bot channels (separate from fleet.yaml):
- `defaults.allowed_guilds` — Discord server whitelist
- `defaults.allowed_groups` — Telegram group whitelist
- `channels` — per-channel backend override
- Hot-reloads every 30 seconds (no restart needed)

**Key config locations:**
- Fleet config: `~/.agend/fleet.yaml`
- Classic bot: `~/.agend/classicBot.yaml`
- Environment: `~/.agend/.env` (bot tokens, API keys)
- Instance logs: `~/.agend/instances/<name>/output.log`
- Runtime logs: `agend logs` / `~/.agend/daemon.log`; service startup errors and Node warnings: `~/.agend/fleet.log`

## Inspect and set an agent’s tool profile

Use `get_fleet_config({ scope: "instance", name })` or `scope: "defaults"` to inspect the current configuration, and `list_deployments` to inspect deployed groups. These read-only tools and `validate_config` are in General’s default profile.

Set a new agent's profile directly, without a confirmation card. Any creator may set a profile at or below its own resolved profile on `create_instance` and `deploy_template`. The order, highest privilege first, is `full`, `general`, `coordinator`, `worker`, `standard`, `minimal`. A non-General creator cannot grant `full` or `general` (those creators are capped at `coordinator`). General may set any writable profile. Above the cap is refused, and the refusal names the cap. The new agent starts on that profile; do not reload. Changing an existing agent's `tool_set` through `update_instance_config` stays General-only.

```js
update_instance_config({ name: "worker", config: { tool_set: "worker" } }) // General only
create_instance({ topic_name: "new-worker", tool_set: "worker" })
```
Writable values: `full`, `standard`, `worker`, `coordinator`, `minimal`. `general` is assigned by role and cannot be written. Both tools refuse `skipPermissions` for everyone, including General; do not pass it. Sensitive Settings changes (tokens, access and admin membership) still use their existing confirmation. An explicitly narrowed General remains narrowed. Nobody can change their own `tool_set` through a create that resolves to the existing agent, or through General's own update; a person may still change it in Settings or fleet.yaml. This direct path covers portable/local agents only. Native Windows keeps its separate admin request for creation and for display name, description or model changes; set its `tool_set` in Settings on the host.

## kiro-cli UI mode (kiro_ui)

For `backend: kiro-cli` instances, `kiro_ui` selects the CLI's UI/agent profile:
```yaml
instances:
  my-kiro:
    backend: kiro-cli
    kiro_ui: tui       # what every new kiro instance is written with (#2598)
    # kiro_ui: legacy  # the classic engine; also what an entry with no kiro_ui runs
```
`kiro_ui: v3` is refused by validation — do not set it.
kiro-cli 3.0 drops the classic engine. Never change `kiro_ui` by hand to move an instance: that starts it on an
empty conversation. An existing classic instance moves with its conversation through `migrate_kiro_instance`
(the kiro-engine-migration skill). Ignored by other backends.

## Reply completion guard

`reply_completion_guard` detects a human-channel turn that ended without a
delivered reply and asks the agent to send one bounded recovery reply. It is
enabled by default for Claude Code, Codex, Muse and Kiro legacy/TUI (it needs the
MCP server). Kiro v3 is excluded because its turn-end signal is unverified. Other
backends keep the setting but do not claim the protection is active.

Prefer a narrow per-instance override when one worker repeatedly finishes work
without posting its conclusion:

```yaml
defaults:
  reply_completion_guard: true   # fleet-wide bottom default
instances:
  unreliable-worker:
    reply_completion_guard: true # per-instance override
```

ClassicBot uses `channels.<id>` → `classicBot.yaml defaults` → `fleet.yaml
defaults`. Both `reply_completion_guard` and `tool_progress` use that chain and
hot-reload without restarting the agent. The switch only enables or disables
recovery; it does not change which trusted human messages require a reply, and
it does not turn tool-call text into proof that the reply reached the channel.

## Access modes

`channel.access.mode` in fleet.yaml decides who may talk to the bot:

| Mode | Who can interact | Use it for |
|------|------------------|------------|
| `locked` | Only the allowlist (`allowed_users`) | Production, a private bot, anything sensitive |
| `open` | Everyone in the channel | A public demo, a shared team bot, testing |

`pairing` is an older name for `locked` that configurations may still carry; write `locked` in new ones.

```yaml
channel:
  access:
    mode: locked
    allowed_users: [123456789]   # used in locked mode
```

Add allowed users in Settings → Chat & connections → Chat connections → the bot → Allowed users (primary bot), through its usual confirmation. Runtime and Hub pairing are separate.

## Config Validation

**After editing fleet.yaml or classicBot.yaml, validate before reloading:**
- `validate_config` MCP tool (preferred) — checks channels, instances, backends,
  access, and both yaml files. Reports errors **and** warnings.
- CLI equivalent: `agend validate`

Fix all errors before `agend reload`; warnings are advisory.

**Common fleet.yaml mistakes:**
- `channel.mode` left out → it is `topic` (say so explicitly if you mean another mode)
- Wrong indentation (YAML is indent-sensitive)
- `topic_id` as string vs number (both work, but be consistent)
- `backend` typo (valid: `claude-code`, `codex`, `opencode`, `kiro-cli`, `antigravity`, `grok`, `muse`); `gemini-cli` was removed in 2.1.12 — use `antigravity`
- `model` using wrong format for the backend
- YAML anchors/aliases (`&x` … `*x`) are fine, but a Settings or tool edit of one place gives that place its own
  value; the others keep theirs (#2208). To change every place, edit fleet.yaml itself.

**Common classicBot.yaml mistakes:**
- `allowed_guilds` values should be quoted strings: numbers are accepted, but a Discord ID above 2^53 loses digits as a YAML integer
- Channel IDs as keys must be quoted strings
- Missing `defaults` section (optional but recommended)

**After editing config:**
```bash
agend reload              # hot-reload (SIGHUP) — behavior switches apply without restart
agend restart             # if channel or other cold defaults changed (--yes from a fleet session)
```
