---
name: session-management
description: Session stores, forking, cross-backend session recovery, and auth-pause recovery
roles: [general]
---

## Auth failure (auto-pause)

When AgEnD sees `auth_error` it **pauses** that instance (`pausePending` sticky):
- One notification **per backend** (not per instance) — log in once, same-backend peers recover.
- Auth is **per-user global** across backends: claude-code, codex, kiro, grok, opencode, antigravity.
- Messages while paused stay in the **queue** — do not re-send.
- After the user re-auths: `wake` / normal wake clears `pausePending`.

## Session recovery: what each backend can do

Verified by running each one, not read from docs.

| Backend | List all sessions | Restore a *specific* session | Read summary only |
|---|---|---|---|
| **kiro-cli** | ✅ `conversations_v2` | ✅ export → `/chat load` | ✅ `latest_summary` |
| **grok** | ✅ `session_search.sqlite` (FTS5) | ✅ `grok --resume <id>` | ✅ `summary.json` |
| **claude-code** | ✅ list `*.jsonl` in project dir | ✅ `claude -r <id>` | ✅ `ai-title` line |
| **codex** | ⚠️ no index — parse rollout files | ✅ `codex exec resume <id>` | ❌ must parse the rollout |
| **antigravity** | ❌ index covers ~23%, 2 months stale | ✅ `agy --conversation <id>` | ⚠️ `title` empty, use `preview` |

**Restoring a specific session is a manual operator action, not an AgEnD feature.** AgEnD always launches a backend on its *most recent* session (`--continue` / `--last` / `--resume`). To reach any other session someone must drive the pane or the CLI by hand.

**kiro is the exception worth knowing:** its export → `/chat load` works on a **live, idle instance** with no restart. Every other backend needs the instance stopped (or the CLI run manually) because the session is chosen by a launch flag.

## Safety — applies to every backend below

1. **Reads are read-only.** Open SQLite with `readonly` and never write to these databases; they belong to a running CLI, and the `-wal`/`-shm` files are live.
2. **Restore through the CLI's own mechanism** — a resume flag, or kiro's `/chat load`. Never edit a session DB or JSONL to "fix" a conversation.
3. **Confirm the target instance is idle first** (tmux shows the ready prompt). Restoring into a working pane interrupts a turn.
4. Nothing here needs `sudo` or touches another user's files.

---

## kiro-cli

- **Store:** `~/.kiro/sessions/cli/<uuid>.json`
- **DB:** `~/.local/share/kiro-cli/data.sqlite3`, table `conversations_v2`
  - `key` — the instance's working directory
  - `conversation_id` — session ID
  - `value` — full session state JSON (**same format as `/chat save`**)
  - `created_at` / `updated_at` — epoch ms

**List sessions for an instance**
```python
import sqlite3, os
db = os.path.expanduser('~/.local/share/kiro-cli/data.sqlite3')
cur = sqlite3.connect(f'file:{db}?mode=ro', uri=True).cursor()
cur.execute(
    "SELECT conversation_id, updated_at FROM conversations_v2 WHERE key LIKE ? ORDER BY updated_at DESC LIMIT 5",
    ('%<instance-name>%',)
)
# Most recent = currently active. De-duplicate by conversation_id.
```

**Restore (works on a live idle instance — no restart)**
```python
cur.execute("SELECT value FROM conversations_v2 WHERE conversation_id = ?", (target_cid,))
open('<instance-workspace>/restore.json', 'w').write(cur.fetchone()[0])
```
```bash
tmux send-keys -t agend:<instance> '/chat load restore.json' Enter
# Success: "✔ Imported chat session state", context % jumps up
```

**Summary without restoring:** the session JSON has `latest_summary` (list; `[1]` is the text) and `history`.

---

## grok

The most capable backend here. It also ships its own manual at `~/.grok/docs/user-guide/17-sessions.md`.

- **Store:** `~/.grok/sessions/<URL-encoded cwd>/<session-id>/`
  - `summary.json` — index entry: summary, timestamps, model, message counts
  - `updates.jsonl` — the authoritative conversation log that drives resume
  - also `chat_history.jsonl`, `plan.json`, `rewind_points.jsonl`, `signals.json`
- **Index:** `~/.grok/sessions/session_search.sqlite` → `session_docs(session_id, cwd, updated_at, title, content)` plus a `session_docs_fts` FTS5 table, so you can full-text search past conversations.

**List / search**
```python
import sqlite3, os
db = os.path.expanduser('~/.grok/sessions/session_search.sqlite')
cur = sqlite3.connect(f'file:{db}?mode=ro', uri=True).cursor()
cur.execute("SELECT session_id, title, updated_at FROM session_docs ORDER BY updated_at DESC LIMIT 10")
# Full-text over conversation content:
cur.execute("SELECT session_id FROM session_docs_fts WHERE session_docs_fts MATCH ?", ('deploy',))
```

**Restore:** `grok --resume <session-id-or-title>` (a UUID is always treated as an ID; anything else matches a title in the current directory). Bare `grok --resume` takes the most recent for that cwd. In the TUI, `/resume` opens a picker that searches conversation content as you type.

**Summary without restoring:** read `summary.json` directly.

> ⚠️ **Titles can be ours, not the user's.** Grok auto-titles from the first prompt, and AgEnD sometimes injects a session snapshot as that first prompt — so a title may read `[system:session-snapshot] ## Previous session…`. Filter that prefix before showing titles to a user, and fall back to `updated_at` + message count.

---

## claude-code

- **Store:** `~/.claude/projects/<path-encoded>/<session-uuid>.jsonl` — **the filename is the session ID**.
- `<path-encoded>` = the absolute cwd with every `/` replaced by `-`.

**List sessions for an instance**
```bash
enc=$(echo "<instance-working-dir>" | sed 's|/|-|g')
ls -t ~/.claude/projects/"$enc"/*.jsonl        # newest first; basename = session id
```

**Summary without restoring** — the transcript contains auto-title lines; take the last one:
```bash
grep -h '"type":"ai-title"' <file>.jsonl | tail -1
# {"type":"ai-title","aiTitle":"Review updated instructions","sessionId":"..."}
```
A session with no `ai-title` line is simply untitled — say so rather than inventing a label.

**Restore:** `claude -r <session-id>` (or `claude --resume` for a picker that accepts a search term). `-c` / `--continue` takes the most recent for the cwd — that is what AgEnD launches with.

> ⚠️ **Check the ID exists before using it.** AgEnD guards `--continue` precisely because resuming a session that isn't there sends claude into a restart loop. Confirm the `<id>.jsonl` file is present in the encoded project dir first.

---

## codex

Restoring works well; **listing is the weak part — there is no index table.**

- **Store:** `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`
- Line 0 of every rollout is the header:
  `{"type":"session_meta","payload":{"session_id":…,"cwd":…,"timestamp":…}}`

**List sessions for a working directory** — walk the tree and read only the first line of each file:
```python
import json, os, pathlib
root = pathlib.Path(os.path.expanduser('~/.codex/sessions'))
want = '<instance-working-dir>'
out = []
for p in root.rglob('*.jsonl'):
    try:
        head = json.loads(p.open(encoding='utf-8').readline())
    except Exception:
        continue
    if head.get('type') == 'session_meta' and head['payload'].get('cwd') == want:
        out.append((head['payload']['timestamp'], head['payload']['session_id']))
for ts, sid in sorted(out, reverse=True):
    print(ts, sid)
```
It opens many files, but only one line each, so it stays cheap.

**Restore:** `codex exec resume <session-id> "<prompt>"` non-interactively, or `codex resume <session-id>` for the TUI (bare `codex resume` opens a picker). `codex resume --last` is what AgEnD launches with. The ID argument also accepts a session *name*.

**Summary:** ❌ none available without parsing. `session_meta` carries only id/cwd/timestamp; to describe a session you must read further `event_msg` lines. Tell the user the timestamp and let them pick, rather than guessing at a topic.

---

## antigravity (agy)

Restore is reliable; **the session list is not — do not present it as complete.**

- **Store:** `~/.gemini/antigravity-cli/conversations/<uuid>.db` — one SQLite database per conversation.
- **Index:** `~/.gemini/antigravity-cli/conversation_summaries.db`, table `conversation_summaries`
  (`conversation_id`, `title`, `preview`, `step_count`, `last_modified_time`, `workspace_uris`, …)

**List (with the caveat below)**
```python
import sqlite3, os
db = os.path.expanduser('~/.gemini/antigravity-cli/conversation_summaries.db')
cur = sqlite3.connect(f'file:{db}?mode=ro', uri=True).cursor()
cur.execute("SELECT conversation_id, preview, step_count, last_modified_time "
            "FROM conversation_summaries ORDER BY last_modified_time DESC")
```

**Restore:** `agy --conversation <conversation-id>`. Verified: it loads the full prior conversation, not just a stub. `-c` / `--continue` takes the most recent — that is what AgEnD launches with.

> ⚠️ **The index is badly incomplete.** Measured on a live machine: 31 conversation databases on disk but only 14 index rows, of which just **7** matched a real conversation — about 23% coverage — and the newest row was **two months old**. Whatever you list, say plainly that it is a partial view and that older or recent conversations may be missing entirely. If the user knows a conversation ID, `--conversation` still works even when the index does not show it.
>
> ⚠️ **`title` is empty in practice** — use `preview` (the first user message) as the label, plus `step_count` for size.
>
> ⚠️ **`agy -p` (print mode) records nothing.** A non-interactive run leaves no conversation behind, so don't expect one to show up afterwards.

---

## Fork (source must be idle)

- **kiro:** `/chat save name.json -f` → `create_instance` → copy workspace file → `/chat load name.json`
- **claude-code:** copy the newest `*.jsonl` into the target's encoded project dir → start (uses `--continue`)
- **grok:** `/fork` inside the TUI branches the conversation into a peer session
- Prefer `replace_instance` when the whole session is poisoned (see instance-lifecycle)
