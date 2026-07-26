---
name: session-management
description: Where kiro-cli and claude-code store sessions, and how to fork one to a new instance
---

## Where sessions live

| | kiro-cli | claude-code |
|---|---|---|
| Store | `~/.kiro/sessions/cli/<uuid>.json` | `~/.claude/projects/<path-encoded>/*.jsonl` |
| Keyed by | session uuid | project (working) directory |
| Reload | `/chat load <file>` | none — `--continue` (latest for the dir) / `--resume <id>` |
| Text export | — | `/export` (plain text, **not** reloadable) |

`<path-encoded>` = the absolute working_directory with `/` → `-`
(e.g. `/home/han/Projects/AgEnD` → `-home-han-Projects-AgEnD`).

## Fork a session to a new instance

Confirm the source is **idle** first (`describe_instance` / `get_fleet_status`) — don't fork mid-task.

**kiro-cli** — save, copy, load:
1. On the source, save: `/chat save <name>.json -f` (paste via tmux if needed).
2. `create_instance` (same backend).
3. `cp ~/.agend/workspaces/<source>/<name>.json ~/.agend/workspaces/<target>/`
4. Load on the target: `/chat load <name>.json`, or set `pre_task_command: "/chat load <name>.json"`.

**claude-code** — copy the `.jsonl` (no save/load command):
1. Newest source session: `ls -lt ~/.claude/projects/<source-encoded>/*.jsonl | head`
2. `create_instance` (backend `claude-code`); note its working_directory.
3. Copy into the target's encoded project dir:
   ```bash
   TARGET_ENC="$(echo '<target-working-dir>' | sed 's#/#-#g')"
   mkdir -p ~/.claude/projects/$TARGET_ENC
   cp ~/.claude/projects/<source-encoded>/<session>.jsonl ~/.claude/projects/$TARGET_ENC/
   ```
4. Start the target — claude-code resumes the newest `.jsonl` via `--continue`.

**Caveats:** a claude-code session only truly makes sense under its original working_directory
(paths inside the transcript refer to it). Pick the right `.jsonl` if several exist (newest by
mtime; compaction/branches create new files). `/export` is text only, not reloadable.

## Backup

Sessions are plain files — back them up by copying the store paths above
(e.g. `cp ~/.kiro/sessions/cli/*.json <dest>/`). Only copy while the instance is idle.
