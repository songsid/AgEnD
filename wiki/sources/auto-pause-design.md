---
type: source
title: "Auto-Pause Design (Cost Guard)"
tags: [architecture, feature, security]
raw: raw/auto-pause-design.md
created: 2026-06-20
updated: 2026-06-20
ingested: 2026-06-20
---

# Auto-Pause Design

## Summary

Auto-Pause is AgEnD's cost control mechanism. Per-instance daily spending limits automatically pause instances that exceed their budget. Currently implemented in `src/cost-guard.ts`.

## Current implementation (v2.0.x)

The Cost Guard system:
1. Tracks per-instance daily costs via statusline parsing
2. Posts warning to Telegram topic when approaching `cost_limit_daily`
3. Stops (pauses) instance when limit is reached
4. Logs `instance_paused` event to event log
5. Automatically resumes the next day (or on manual restart)

Display: `⏸ proj-c — paused (cost limit)`

## Architecture

- **Source**: `src/cost-guard.ts`
- **Config**: `cost_limit_daily` per instance in fleet.yaml (USD)
- **Events**: `instance_paused`, `instance_resumed`
- **Integration**: Event log, Telegram notifications, `agend ls` status display

## v2.1.0 — Auto-Pause (planned)

Confirmed design from Leader (2026-06-20):
- **Trigger**: instance 閒置超過 72 小時
- **Pause**: kill tmux pane，保留 session-id（可 resume）
- **Wake**: 訊息路由到 paused instance → 自動 spawn + `--resume`
- **Exemptions**: `general` instance + `never_pause: true` 白名單
- **Persistence**: marker file 記錄 pause 狀態（跨 daemon restart）
- **Message queue**: wake 期間訊息排隊，完成後依序注入
- **Display**: `/api/fleet` + `agend ls` 顯示 ⏸ Paused

## Related

- [[cost-guard]]
- [[crash-recovery]]
