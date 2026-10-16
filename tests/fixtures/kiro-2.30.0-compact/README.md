# kiro-cli 2.30.0: `/compact` (board 003648ac)

Captured 2026-10-16 from the real kiro-cli 2.30.0 on Linux, in a private tmux server, in scratch working directories
(no fleet, no live instance). Two one-word prompts, then `/compact`, on each engine AgEnD launches:

- **TUI, V2 engine** (`--tui --agent-engine=v2`): the pane says `• Compacting conversation...`, then shows the summary.
  The session log (`~/.kiro/sessions/cli/<id>.jsonl`) gets one top-level record
  `{"version":"v1","kind":"Compaction","data":{"summary",…,"strategy",…,"messages_snapshot":[…]}}`
  (`tui-v2-session.jsonl`; its snapshot holds the old messages).
- **Classic, V1 engine** (`--legacy-ui --agent-engine=v1`): the pane says `Creating summary...`, then the summary and
  "The conversation history has been replaced with this summary." The store (`data.sqlite3`, `conversations_v2`)
  gets a **new row** for the directory, with a new `conversation_id` and `created_at`, whose `latest_summary` is
  `[<summary>, {request_id, …}]` where the old row's was `null`. Both rows keep 2 history entries, and the old row stays
  (`classic-v1-rows.json`: the two rows, `history`, `latest_summary` and `valid_history_range` only).

Paths are replaced (`/work/kiro-tui`, `/work/kiro-classic`); nothing else is changed.
