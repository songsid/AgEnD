# Advanced Skills

> **Note: These skills apply to kiro-cli backend instances only.**

## 1. Instance Health Check via tmux

When user asks to check an instance's status or what it's doing:
- Use `execute_bash` to run: `tmux capture-pane -t agend:<instance-name> -p | tail -20`
- This shows the actual CLI screen (what the agent sees right now)
- More useful than just "running/stopped" status
- If the instance appears stuck, suggest `/raw /compact` or restart

## 2. Reviewer Session Management

For reviewer instances using kiro-cli:
- Recommend setting `pre_task_command: "/chat load reviewer-base.json"` in fleet.yaml
- This loads a base session with review guidelines on every restart
- Help user create the base session:
  1. Attach to reviewer: `agend attach <reviewer-instance>`
  2. Set up review context and guidelines
  3. Save: `/chat save reviewer-base.json -f`
  4. Add to fleet.yaml under the reviewer instance config:
     ```yaml
     instances:
       reviewer-xxx:
         pre_task_command: "/chat load reviewer-base.json"
     ```

## 3. Fork Instance (Session Cloning)

When user wants to fork/clone an instance's session to a new instance:

Steps:
1. Wait for source instance to be idle (check with tmux capture-pane, look for "X% !>" prompt)

2. Save current session on source instance via tmux:
   - `execute_bash`: `tmux send-keys -t agend:<source-instance> '/chat save YYYYMMDD.json -f' Enter`
   - Wait a few seconds for save to complete

3. Create new instance:
   - `create_instance` with same backend and working_directory (or new one)

4. Copy session file to new instance workspace:
   - `execute_bash`: `cp ~/.agend/workspaces/<source>/YYYYMMDD.json ~/.agend/workspaces/<target>/`

5. Wait for new instance to be idle, then load session via tmux:
   - `execute_bash`: `tmux send-keys -t agend:<new-instance-name> '/chat load YYYYMMDD.json' Enter`
   - Or configure `pre_task_command: "/chat load YYYYMMDD.json"` for auto-load on restart

## 4. Batch Session Backup

Save all instances' sessions to a dated backup directory:

```bash
DATE=$(date +%Y%m%d)
BACKUP_DIR="$HOME/.agend/session-backups/$DATE"
mkdir -p "$BACKUP_DIR"
MY_NAME="<your-own-instance-name>"  # skip yourself to avoid paste collision
for win in $(tmux list-windows -t agend -F '#{window_name}' | grep -v bash); do
  if [ "$win" = "$MY_NAME" ]; then continue; fi
  tmux send-keys -t "agend:$win" "/chat save $BACKUP_DIR/${win}.json -f" Enter
  sleep 3
done
```

Important:
- Skip your own instance (the one executing this) to avoid paste collision
- Use `sleep 3` between saves
- Run fleet health check first — only backup idle instances
- Do NOT backup while instances are busy

Restore a single instance:
- `tmux send-keys -t agend:<instance> '/chat load /path/to/backup.json' Enter`

## 5. Fleet Health Check

Check all instances for stuck/error state:

```bash
for win in $(tmux list-windows -t agend -F '#{window_name}' | grep -v bash); do
  last=$(tmux capture-pane -t "agend:$win" -p | tail -3 | tr '\n' ' ')
  if echo "$last" | grep -q "!>"; then
    echo "✅ $win — idle"
  elif echo "$last" | grep -q "error:"; then
    echo "❌ $win — ERROR"
  else
    echo "⏳ $win — busy"
  fi
done
```

States:
- ✅ idle — prompt visible (X% !>), ready for input
- ⏳ busy — processing a task, wait for it to finish
- ❌ error — check tmux pane for details, may need restart

If an instance is stuck (busy for >10 minutes with no output), restart it:
- `restart_instance("<instance-name>")`

## 6. Instance Creation Safety

When creating a new instance with `create_instance`:

**Pre-checks (mandatory):**
1. **Check for duplicate working directory** — Run `list_instances` and verify no existing instance uses the same `working_directory`. Two instances sharing a directory causes file conflicts and race conditions.
2. **Verify the directory exists** — If specifying a directory, confirm it exists on disk before calling create.
3. **Use unique names** — The instance name is derived from `topic_name` or `basename(directory)`. Avoid generic names like "dev" or "test" that may collide.

**Post-checks (mandatory):**
4. **Confirm topic/channel creation** — After `create_instance` returns, verify the response includes a valid `topic_id`. This confirms the Discord channel or Telegram topic was actually created.
5. **Verify instance is running** — Use `describe_instance` to confirm the new instance reached "running" status. If it shows "stopped" or errors, check the output log.

**Common mistakes to avoid:**
- Do NOT create an instance pointing to another instance's worktree path
- Do NOT reuse a `topic_name` that already exists (Discord will create a duplicate channel)
- Do NOT omit `topic_name` when `directory` is not provided — it will error

## 7. Fleet Restart & Recovery

**Restart types:**
- `agend fleet restart` — full stop + start (picks up new code after build & link)
- `agend reload` — SIGHUP hot-reload, reconciles instances without restarting the fleet process
- `restart_instance("<name>")` — single instance restart, reloads fleet.yaml first

**After tmux crash:**
- Fleet auto-detects tmux server death and triggers circuit breaker (30s pause)
- Some instances may fail to restart due to rate limits from simultaneous startup
- Fix: manually restart failed instances, or do another `agend fleet restart`
- Check failed instances: `agend ls` shows "stopped" status

**Rate limit recovery:**
- If you see "PTY error: Rate limit reached" or "crash loop — respawn paused", wait 1-2 minutes
- Then `restart_instance` the affected instance
- Do NOT restart all instances simultaneously — this worsens rate limits

## 8. Configuration Quick Reference

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

## 9. Instance Lifecycle Management

**Replace vs Restart:**
- `restart_instance` — keeps session, reloads config. Use when config changed.
- `replace_instance` — kills old, creates fresh with handover context. Use when context is polluted or instance is stuck in a loop.

**When to replace (not restart):**
- Instance keeps hallucinating or referencing stale information
- Instance is stuck in a tool-call loop
- Context is >80% full and responses are degrading

**Monitoring instance state:**
- `describe_instance("<name>")` — shows status, last activity, description
- `tmux capture-pane -t agend:<name> -p | tail -20` — see actual CLI screen
- Look for `X% !>` prompt = idle, `Thinking...` = busy, `error` = needs attention

## 10. Safe Update & Restart

**Update AgEnD to latest version:**
```bash
agend update              # update to latest
agend update --version 0.0.6  # pin specific version
```

The `agend update` command automatically:
- Detects if sudo is needed (switches to nvm if so)
- Installs new version
- Verifies installation succeeded
- Updates service file (ExecStart path)
- Restarts fleet

**Manual restart (if update isn't needed):**
```bash
agend fleet restart       # graceful restart (SIGUSR2) — keeps sessions, reloads config
agend fleet stop && agend fleet start  # full restart — new code takes effect
```

**NEVER do:**
- `kill -9` on the fleet process (corrupts state)
- Edit fleet.yaml while fleet is restarting
- Run `agend update` while another update is in progress

## 11. Model Names by Backend

Models are specified in fleet.yaml `defaults.model` or per-instance `model` field.

| Backend | Model Names | Default |
|---------|-------------|---------|
| **kiro-cli** | `claude-sonnet-4-20250514`, `claude-opus-4-20250514`, `claude-haiku-3-20250307` | auto (latest) |
| **claude-code** | `sonnet`, `opus`, `haiku`, `opusplan`, `best`, `sonnet[1m]`, `opus[1m]` | sonnet |
| **gemini-cli** | `gemini-2.5-pro`, `gemini-2.5-flash` | auto |
| **codex** | `gpt-4o`, `o3`, `o4-mini` | gpt-4o |
| **opencode** | depends on provider config | — |

**Important:** kiro-cli uses FULL model IDs (e.g. `claude-sonnet-4-20250514`), NOT short names like `sonnet`. Claude Code uses short names. Don't mix them up.

Example fleet.yaml:
```yaml
defaults:
  backend: kiro-cli
  model: claude-sonnet-4-20250514

instances:
  heavy-task:
    model: claude-opus-4-20250514
```

## 12. Config Validation

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
- `backend` typo (valid: `claude-code`, `gemini-cli`, `codex`, `opencode`, `kiro-cli`)
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

## 13. What NOT to Do (Dangerous Operations)

- **Don't delete `~/.agend/fleet.yaml`** while fleet is running
- **Don't delete `~/.agend/fleet.pid`** manually — use `agend fleet stop`
- **Don't kill tmux server** (`tmux kill-server`) — kills all agent sessions
- **Don't edit instance output.log** — it's actively written by the daemon
- **Don't run two fleet processes** on the same AGEND_HOME — port/socket conflicts
- **Don't change `channel.group_id`** without re-creating all topics — routing breaks
- **Don't remove an instance from fleet.yaml** that has active work — stop it first

## 14. Access Mode Reference

fleet.yaml `channel.access.mode` valid values:

| Mode | Behavior |
|------|----------|
| `locked` | Only `allowed_users` can interact (default) |
| `pairing` | Users can request access via `/pair` command |
| `open` | All users can interact, no restrictions |

Example:
```yaml
channel:
  access:
    mode: open          # everyone can use
    # mode: locked      # whitelist only (add allowed_users)
    # mode: pairing     # users self-register via /pair
    allowed_users: [123456789]  # only needed for locked/pairing
```

**When to use each:**
- `locked` — production, private bot, security-sensitive
- `pairing` — semi-open, users request access with admin approval
- `open` — public demo, shared team bot, testing
