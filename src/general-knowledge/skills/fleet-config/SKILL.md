---
name: fleet-config
description: fleet.yaml and classicBot.yaml structure, validation, common mistakes
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
- Fleet log: `~/.agend/fleet.log`

## Config Validation

**Before editing fleet.yaml or classicBot.yaml, always validate after:**

```bash
# Validate fleet.yaml syntax
agend fleet start --dry-run 2>&1 | head -5
# Or simply:
node -e "const yaml = require('js-yaml'); const fs = require('fs'); yaml.load(fs.readFileSync('$HOME/.agend/fleet.yaml', 'utf-8')); console.log('✓ valid YAML')"
```

**Common fleet.yaml mistakes:**
- Missing `channel.mode` field → error on start
- Wrong indentation (YAML is indent-sensitive)
- `topic_id` as string vs number (both work, but be consistent)
- `backend` typo (valid: `claude-code`, `gemini-cli`, `codex`, `opencode`, `kiro-cli`, `antigravity`)
- `model` using wrong format for the backend

**classicBot.yaml validation:**
```bash
node -e "const yaml = require('js-yaml'); const fs = require('fs'); yaml.load(fs.readFileSync('$HOME/.agend/classicBot.yaml', 'utf-8')); console.log('✓ valid YAML')"
```

**Common classicBot.yaml mistakes:**
- `allowed_guilds` values must be strings (Discord IDs are too large for YAML integers)
- Channel IDs as keys must be quoted strings
- Missing `defaults` section (optional but recommended)

**After editing config:**
```bash
agend reload              # hot-reload (SIGHUP) — adds/removes instances without restart
agend fleet restart       # if channel/defaults changed — needs full restart
```
