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
