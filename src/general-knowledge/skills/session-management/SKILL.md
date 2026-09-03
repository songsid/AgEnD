---
name: session-management
description: Session stores, forking, and auth-pause recovery
roles: [general]
---

## Auth failure (auto-pause)

When AgEnD sees `auth_error` it **pauses** that instance (`pausePending` sticky):
- One notification **per backend** (not per instance) — log in once, same-backend peers recover.
- Auth is **per-user global** across backends: claude-code, codex, kiro, grok, opencode, antigravity.
- Messages while paused stay in the **queue** — do not re-send.
- After the user re-auths: `wake` / normal wake clears `pausePending`.

## Where sessions live

| | kiro-cli | claude-code |
|---|---|---|
| Store | `~/.kiro/sessions/cli/<uuid>.json` | `~/.claude/projects/<path-encoded>/*.jsonl` |
| Reload | `/chat load <file>` | `--continue` / `--resume <id>` |

`<path-encoded>` = absolute cwd with `/` → `-`.

## Fork (source must be idle)

- **kiro:** `/chat save name.json -f` → `create_instance` → copy workspace file → `/chat load name.json`
- **claude-code:** copy newest `*.jsonl` into target's encoded project dir → start (uses `--continue`)
- Prefer `replace_instance` when the whole session is poisoned (see instance-lifecycle)

## Kiro SQLite session query/recovery (kiro-cli only)

Kiro-cli stores active and recent sessions in SQLite — useful when you need to inspect or recover a session that isn't in the JSON files yet.

### Database location and schema

- **DB:** `~/.local/share/kiro-cli/data.sqlite3`
- **Table:** `conversations_v2`
- **Columns:**
  - `key TEXT` — instance's working directory (e.g. `/home/han/.agend/workspaces/m365-xxx`)
  - `conversation_id TEXT` — unique session ID
  - `value TEXT` — full session state JSON (**same format as `/chat save` export**)
  - `created_at INTEGER` — timestamp in milliseconds
  - `updated_at INTEGER` — timestamp in milliseconds

### Query sessions for an instance

```python
import sqlite3, os
db = os.path.expanduser('~/.local/share/kiro-cli/data.sqlite3')
cur = sqlite3.connect(db).cursor()
cur.execute(
    "SELECT conversation_id, updated_at FROM conversations_v2 WHERE key LIKE ? ORDER BY updated_at DESC LIMIT 5",
    ('%<instance-name>%',)
)
# Results: most recent = currently active session, second = previous session
# De-duplicate by conversation_id if multiple rows share the same ID
```

### Recover a previous session

```python
# Export the session JSON to a file
cur.execute("SELECT value FROM conversations_v2 WHERE conversation_id = ?", (target_cid,))
open('<instance-workspace>/restore.json', 'w').write(cur.fetchone()[0])
```

```bash
# Confirm the instance is idle (tmux shows X% !> ready prompt), then load
tmux send-keys -t agend:<instance> '/chat load restore.json' Enter
# Success: "✔ Imported chat session state", context % jumps up
```

### Read session summary (inspect without recovery)

The session JSON contains:
- `latest_summary` — list, `[1]` is the summary text
- `history` — array of conversation turns

### Safety requirements

1. **Read-only queries only (SELECT)** — never write to `data.sqlite3` (it's kiro-cli's active database; writing may corrupt running sessions)
2. **Recovery via export + `/chat load`** — do not modify the DB directly
3. **Confirm target instance is idle before loading** — check tmux for the ready prompt
4. **Kiro-cli specific** — this method does not apply to other backends
