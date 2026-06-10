---
name: instance-lifecycle
description: Replace vs restart instances, monitoring state, when to use each
---

## Instance Lifecycle Management

**Replace vs Restart:**
- `restart_instance` — keeps session, reloads config. Use when config changed.
- `replace_instance` — kills old, creates fresh with handover context. Use when context is polluted or instance is stuck in a loop.

**When to replace (not restart):**
- Instance keeps hallucinating or referencing stale information
- Instance is stuck in a tool-call loop
- Context is reported >80% full and responses are degrading (only applicable to backends that report context usage)

**Monitoring instance state:**
- `describe_instance("<name>")` — shows status, last activity, description
- `tmux capture-pane -t agend:<name> -p | tail -20` — see actual CLI screen
- Look for `X% !>` prompt = idle, `Thinking...` = busy, `error` = needs attention
