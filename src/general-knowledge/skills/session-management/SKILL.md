---
name: session-management
description: Save/load/fork sessions, batch backup, reviewer session setup, kiro-cli and claude-code session paths
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

## Claude Code Session Storage & Fork

claude-code stores conversation sessions as JSONL, **keyed by the project (working) directory**:
- **Path:** `~/.claude/projects/<project-path-encoded>/*.jsonl`
- `<project-path-encoded>` is the absolute working_directory with `/` replaced by `-`
  (e.g. `/home/han/Projects/AgEnD` → `-home-han-Projects-AgEnD`)
- Each `.jsonl` is one session (full message history). Latest = most recently modified.

**Key difference from kiro-cli:** claude-code has **no `/chat save` / `/chat load`**. You resume
only via `--continue` (latest session for this dir) or `--resume <id>`. `/export` produces
plain text only — it **cannot** be reloaded as a session. So forking is done by **copying the
`.jsonl` file**, not by save/load commands.

### Fork a claude-code session to a new instance

1. **Confirm source instance is idle** — `tmux capture-pane -t agend:<source> -p | tail -5`
   (look for the ready prompt, e.g. `❯`). Don't fork mid-task.

2. **Find the source session file** (newest first):
   ```bash
   ls -lt ~/.claude/projects/<source-path-encoded>/*.jsonl | head -5
   ```

3. **Create the new instance** with `create_instance` (backend: `claude-code`). Note its
   `working_directory` — it determines the target project path.

4. **Copy the `.jsonl` into the new instance's encoded project dir:**
   ```bash
   TARGET_ENC="$(echo '<target-working-dir>' | sed 's#/#-#g')"
   mkdir -p ~/.claude/projects/$TARGET_ENC
   cp ~/.claude/projects/<source-path-encoded>/<session>.jsonl \
      ~/.claude/projects/$TARGET_ENC/
   ```

5. **Start/restart the new instance** — the claude-code backend resumes via `--continue`
   (it auto-picks the latest session for that project dir), so the copied session is continued.

### Caveats
- **Same project path required:** a session can only resume under the working_directory it
  was recorded in. If the target dir differs, claude-code still loads it via `--continue`
  (it reads the newest `.jsonl` in the target's encoded dir), but file paths/context inside
  the transcript will refer to the original dir.
- `/export` = text only, not reloadable. Use the raw `.jsonl`.
- Pick the **right** `.jsonl` if multiple exist (sort by mtime; each branch/compaction can
  create new files).

### kiro-cli vs claude-code fork (summary)
| | kiro-cli | claude-code |
|---|---|---|
| Store | `~/.kiro/sessions/cli/<uuid>.json` | `~/.claude/projects/<path-encoded>/*.jsonl` |
| Keyed by | session uuid | project (working) directory |
| Fork method | `/chat save` → copy → `/chat load` | copy `.jsonl` → `--continue` |
| Reload command | `/chat load <file>` | none — `--continue` / `--resume` only |
| Text export | — | `/export` (not reloadable) |

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
