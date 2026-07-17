---
type: concept
title: "Crash Recovery & Context Management"
tags: [architecture, fleet]
sources: [auto-pause-design]
created: 2026-06-20
updated: 2026-06-20
---

# Crash Recovery & Context Management

## Overview

AgEnD's approach to context management evolved through 4 versions. The current design (v4) delegates context management to CLI auto-compact and only handles crash recovery.

## Evolution

| Version | Approach | Problem |
|---------|----------|---------|
| v1 | 40% threshold → /compact → fresh start | Threshold too low, context lost |
| v2 | 60% threshold → handover prompt → rotate | Depends on LLM self-reporting (fragile) |
| v3 | 80% threshold → daemon snapshot → kill → spawn | Conflicts with CLI auto-compact |
| v4 (current) | No active rotation; CLI handles compact | Clean separation of concerns |

## Current design (v4)

- **No proactive rotation** — removed threshold + max_age triggers
- **CLI auto-compact** — Claude Code, Codex, Gemini CLI, OpenCode, Kiro CLI all have built-in context compaction
- **AgEnD's role**: crash recovery (health check + respawn + snapshot) and `replace_instance` (cross-instance handover)

## Crash recovery

- Health check via tmux pane status
- Respawn with context snapshot injection
- Crash loop detection: 3+ crashes in 5-min sliding window → pause respawn
- Fleet-level circuit breaker: 2+ tmux server crashes in 5 min → pause all respawns 30s

## Sources

- [[auto-pause-design]]
- See also: `/home/han/Projects/AgEnD/docs/context-rotation-design.md`
