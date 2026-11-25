---
name: instance-lifecycle
description: creating an instance (working directory, tool profile); restart vs replace vs pause/wake and when to use each
roles: [general]
---

## Create with a tool profile

Any creator may supply `tool_set` to `create_instance` or `deploy_template`, without a confirmation card. The profile must be at or below the creator’s own resolved profile. Highest privilege first: `full`, `general`, `coordinator`, `worker`, `standard`, `minimal`. A non-General creator cannot grant `full` or `general`; the refusal names the cap. General may set any writable profile. Changing an existing agent's `tool_set` through `update_instance_config` stays General-only. See the fleet-config skill. `skipPermissions` remains refused even for General. Nobody can change their own `tool_set` through a create that resolves to the existing agent, or through General's own update; a person may still change it in Settings or fleet.yaml. Do not add a redundant reload after creation; the fleet reconciles itself and the new agent starts on that profile. This direct path covers portable/local agents only. Native Windows keeps its separate admin request for creation and for display name, description or model changes; set its `tool_set` in Settings on the host.

## Choose a working directory

Give each instance a dedicated directory, such as `~/projects/my-project`, or leave `directory` out and let AgEnD create a workspace (then pass `topic_name`). `create_instance` refuses `.`, `./`, `~`, `/root` and `/`: an agent started there would write its CLI's configuration into shared places (kiro, for example, would write MCP settings into the global `~/.kiro/`) and affect every instance. When the fleet sets `project_roots`, the directory must sit inside one of them. A directory another instance already uses returns `already_exists` with that instance, so reuse it. After creating, confirm with `describe_instance` that the instance reached "running", and read its log if it stopped.

## Restart vs Replace vs Stop / Delete

- `restart_instance("<name>")` — keeps the session, reloads config. Use when config changed.
- `replace_instance("<name>")` — kills old, creates a fresh instance with handover context.
  Use when the session is the problem: hallucinating / referencing stale info, stuck in a
  tool-call loop, or context is degrading (only backends that report context % surface that).
- `stop_instance("<name>")` / `start_instance("<name>")` — stop or start an instance without removing its configuration or topic.
- `delete_instance("<name>")` — stop and remove the instance, its schedules and team memberships, and its own chat topic (by default; pass `delete_topic: false` to keep the topic). On Discord the topic is a channel, so its history goes too. The General topic and a topic another agent uses are never deleted. The result's `topic_deleted` is the platform's answer; when it is false, `topic_reason` says why (for example, the Telegram bot lacks the Manage Topics admin right) — the agent is deleted either way.

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
