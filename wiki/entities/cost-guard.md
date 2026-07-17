---
type: entity
title: "Cost Guard"
tags: [feature, security]
sources: [auto-pause-design]
created: 2026-06-20
updated: 2026-06-20
---

# Cost Guard

## Overview

Per-instance daily spending limit system. Automatically pauses instances that exceed their budget.

## Configuration

```yaml
# fleet.yaml per-instance
instances:
  my-instance:
    cost_limit_daily: 5.00  # USD
```

## Behavior

1. Monitors instance costs via statusline parsing
2. Posts warning when approaching limit
3. Pauses (stops) instance at limit
4. Logs `instance_paused` event
5. Auto-resumes next day or on manual restart

## Display

```
⏸ proj-c — paused (cost limit)
```

## Source code

- `src/cost-guard.ts`

## Sources

- [[auto-pause-design]]
