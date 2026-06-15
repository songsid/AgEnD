---
name: fleet-health
description: Check instance health via tmux, detect stuck agents, fleet-wide health scan
---

## Instance Health Check via tmux

When user asks to check an instance's status or what it's doing:
- Use `execute_bash` to run: `tmux capture-pane -t agend:<instance-name> -p | tail -20`
- This shows the actual CLI screen (what the agent sees right now)
- More useful than just "running/stopped" status
- If the instance appears stuck, suggest `/raw /compact` or restart

## Fleet Health Check

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

## Unsticking a Frozen Instance via tmux

If an instance is frozen (not responding, no output, no prompt):
1. Send Ctrl+C via tmux to interrupt the current operation:
   ```bash
   tmux send-keys -t agend:<instance-name> C-c
   ```
2. Wait a few seconds, then check if it returned to idle:
   ```bash
   tmux capture-pane -t agend:<instance-name> -p | tail -5
   ```
3. If it shows the prompt (`X% !>` or `(To exit the CLI...)`) — it's unstuck. Resend the task.
4. If still frozen after Ctrl+C, use `restart_instance("<instance-name>")`

**When to use Ctrl+C vs restart:**
- Ctrl+C: instance is alive but stuck on a long operation (API timeout, large file read, infinite loop)
- restart: instance is completely dead (no tmux pane, crash loop, or Ctrl+C doesn't help)
