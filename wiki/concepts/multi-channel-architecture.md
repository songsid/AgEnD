---
type: concept
title: "Multi-Channel Architecture"
tags: [architecture, telegram, discord]
sources: [changelog-v2.0.2]
created: 2026-06-20
updated: 2026-06-20
---

# Multi-Channel Architecture

## Overview

AgEnD supports multiple messaging platforms simultaneously (Telegram + Discord). Each adapter runs independently with its own General instance.

## Design

- Each adapter gets its own General instance (no shared General)
- `channel_id` field in fleet.yaml explicitly binds instances to specific adapters
- Unbound General instances are adopted by topic_id match
- Platform detection uses `channel_id` → channels config type (not name heuristic)

## Key components

- **Adapters**: TelegramAdapter, DiscordAdapter (plugin)
- **General instances**: One per adapter, handles routing and notifications
- **`assignTopicIds`**: Maps instances to adapters via `channel_id` config
- **Quickstart live add**: Can add a second platform while fleet is running

## Implementation notes

- systemd restart is preferred when adding a platform; fallback: detached spawn
- Each adapter has its own AccessManager (allowed_users scope)
- MessageBus routes per-adapter

## Sources

- [[changelog-v2.0.2]] (v2.0.2 introduced multi-channel auto-detect)
