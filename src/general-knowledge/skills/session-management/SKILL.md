---
name: session-management
description: Save/load/fork sessions, batch backup, reviewer session setup, kiro-cli session paths
---

## kiro-cli Session Storage

kiro-cli automatically stores conversation sessions at:
- **Path:** `~/.kiro/sessions/cli/<uuid>.json`
- Each session is a JSON file with the full conversation history
- Sessions persist across restarts — kiro-cli auto-resumes the latest session for each working directory

**Useful for:**
- Manual backup: `cp ~/.kiro/sessions/cli/*.json ~/backup/`
- Finding a specific session: `ls -lt ~/.kiro/sessions/cli/ | head -5`
- Loading a session into a new instance via `pre_task_command: "/chat load <path>"`

## Reviewer Session Management

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

## Fork Instance (Session Cloning)

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

## Batch Session Backup

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
