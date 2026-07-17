---
type: entity
title: "Instance Warmup"
tags: [feature, fleet]
sources: [changelog-v2.0.3]
source_version: v2.0.11
created: 2026-06-20
updated: 2026-07-04
---

# Instance Warmup

## Overview

Auto-trigger context loading after instance spawn. Introduced in v2.0.3, refined in v2.0.11.

## Behavior (v2.0.11)

1. Instance is spawned (tmux pane created, CLI backend starts)
2. **Skip on first run** — brand new instances don't get warmup (no steering to load yet)
3. **Defer when idle** — warmup only fires after instance reaches initial idle state
4. System sends a warmup message with "do not reply" instruction
5. Daemon waits for instance to reach idle state again
6. Warmup marked complete

## Changes (v2.0.11)

- **Skip first run** — prevents false trigger on brand new instances with no steering files
- **Defer when idle** — avoids warmup racing with CLI startup
- **"Do not reply" instruction** — prevents agent from attempting to respond to warmup message

## Integration

- `agend ls` shows Idle/Busy indicator per instance
- Warmup waits for idle before marking ready
- Works with all CLI backends

## Sources

- [[changelog-v2.0.3]]
