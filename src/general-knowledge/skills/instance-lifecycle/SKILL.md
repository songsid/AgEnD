---
name: instance-lifecycle
description: restart vs replace vs pause/wake; when to use each
roles: [general]
---

## Restart vs Replace

- `restart_instance("<name>")` — keeps the session, reloads config. Use when config changed.
- `replace_instance("<name>")` — kills old, creates a fresh instance with handover context.
  Use when the session is the problem: hallucinating / referencing stale info, stuck in a
  tool-call loop, or context is degrading (only backends that report context % surface that).

## Pause / Wake (resource management)

- `pause_instance("<name>")` — stop the resident CLI but keep the instance; frees resources.
- `wake_instance("<name>")` — bring a paused instance back.
- Instances also pause automatically: `auto_pause_after` (idle minutes) and `warm_cap`
  (fleet-wide cap — the least-recently-active idle instance is paused when over the cap).
  The **general** instance is never auto-paused.
- You don't need to wake before sending work: delivery wakes a paused instance first.

## Session-OOM stop

A repeated, confirmed same-session OOM is a terminal stop, not an idle pause.
The stop survives fleet restarts; incoming messages and queued work cannot lift it.
Free memory and investigate before choosing an explicit per-instance Start, Restart
or Wake (including the authorized lifecycle tools) to retry. This preserves the
session and transcript. A fleet-wide restart is not that choice. If another restart
is already finishing, wait and retry the per-instance action. Unknown or damaged
stop evidence also holds automatic launches. A save-failure notice means storage
must be repaired before restarting the fleet; do not promise the stop is durable.

## Monitoring state

- `describe_instance("<name>")` / `list_instances` — status + `instance_state` (idle / working /
  stuck / paused / awaiting_input) + last activity (the daemon derives the state; don't scrape pane
  prompts). `get_fleet_status` only counts running / paused / stopped.
- For the raw screen, see the fleet-health skill (`get_instance_logs` / tmux capture), including
  why faint text in another instance's input box is a CLI suggestion, not the operator's input.
