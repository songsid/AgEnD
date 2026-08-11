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

## Monitoring state

- `get_fleet_status` / `describe_instance("<name>")` — status + idle/working/stuck + last
  activity (the daemon derives the state; don't scrape pane prompts).
- For the raw screen, see the fleet-health skill (`get_instance_logs` / tmux capture).
