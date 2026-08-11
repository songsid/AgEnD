---
name: fleet-health
description: Check instance health and what an agent is doing; recover a stuck instance
roles: [general]
---

## Check health

Prefer the fleet tools — they already know each instance's state:
- `get_fleet_status` — status + execution state (idle / working / stuck) for every instance.
- `describe_instance("<name>")` — one instance's status, last activity, description.
- `list_instances` — quick roster.

The daemon derives idle/working/stuck itself (per-backend), so you do **not** need to
scrape prompts. Don't hand-write pane-text checks like `X% !>` — that prompt is
kiro-specific and wrong for claude-code / codex / grok / antigravity.

## See what an agent is actually doing

When the user wants the live screen (not just a status word):
- `get_instance_logs("<name>")` — recent output.
- Raw terminal (last resort, no tool for the live pane):
  `tmux capture-pane -t agend:<name> -p | tail -20`

## Recover a stuck instance

Do this when the user asks, or confirm first — don't silently restart others' work.
- `restart_instance("<name>")` — reloads config, keeps the session. First choice for a
  dead/looping instance.
- `replace_instance("<name>")` — fresh instance with handover context, when the session
  itself is the problem (see instance-lifecycle skill).

A genuinely wedged CLI can sometimes be freed without a restart by interrupting it —
that is the cancel key, exposed to users as the Cancel button / `/cancel`. Only drop to
`tmux send-keys -t agend:<name> C-c` (kiro) / `Escape` (others) if the tools aren't enough.
