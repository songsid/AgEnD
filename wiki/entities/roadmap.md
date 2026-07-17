---
type: entity
title: "Roadmap"
tags: [version, feature, architecture]
sources: [roadmap-2026-06-20]
created: 2026-06-20
updated: 2026-06-20
---

# AgEnD Roadmap

## v2.0.3 (current beta — 待測後 release)

| Feature | Status |
|---------|--------|
| 統一 /update（TG+DC spawn agend update） | done |
| DC Fleet /status /sysinfo /restart /ctx /compact /collab | done |
| TG Classic /compact | done |
| Fleet open mode bot bypass | done |
| DC auto-collab on /start | done |
| Instance warmup (idle wait) | done |
| agend ls Idle/Busy/Crashed/Stopped | done |
| Health port retry loop fix | done |
| /update beta auto-detect | done |
| Fleet ready 版號顯示 | done |

## v2.1.0 (planned — Auto-Pause)

| Feature | Description |
|---------|-------------|
| 閒置 72hr 自動 pause | kill tmux，保留 session-id |
| 自動 wake | 訊息路由到 paused instance → 自動 wake（--resume） |
| never_pause 白名單 | general + never_pause 設定豁免 |
| Paused 狀態持久化 | marker file 記錄 pause 狀態 |
| Message queue during wake | wake 期間的訊息排隊 |
| UI 顯示 | /api/fleet + agend ls 顯示 ⏸ Paused |

### Auto-Pause 設計要點

- **觸發條件**: instance 閒置超過 72 小時
- **Pause 行為**: kill tmux pane，但保留 session-id（可 resume）
- **Wake 行為**: 收到訊息時自動 spawn + `--resume` 恢復 context
- **豁免**: `general` instance 和標記 `never_pause: true` 的 instance 不會被 pause
- **持久化**: marker file 記錄 pause 狀態（跨 daemon restart 生效）
- **訊息處理**: wake 期間訊息進入 queue，wake 完成後依序注入
- **顯示**: `agend ls` 和 `/api/fleet` 顯示 ⏸ Paused 狀態

### 狀態機

Running → (idle 72hr) → Paused → (message) → Running

### Wake 策略（按來源）

| Source | Wake? | Mode |
|--------|-------|------|
| User message | ✅ | sync |
| Fleet comms | ✅ | async |
| Broadcast | ❌ | skip |
| Schedule | ❌ | skip（有 schedule 者不 pause）|

### Guardrails

並發閘、broadcast 不 wake、schedule 排除、async wake、correlation_id 去重、wake ack、waking 鎖、stale-context 提示

### 架構

- 抽 `deliverToInstance()` facade（統一 5 個 delivery 出口）
- 實作順序：facade → 排除條件 → wakePolicy → CLI marker

## 未來考慮

- Fleet /save /load（session 管理）
- Busy detection 改善（kiro thinking 偵測）
- registerBotCommands retry on timeout
- Web UI config editor

## Related

- [[cost-guard]] — 現有 cost-based auto-pause
- [[instance-warmup]] — 啟動時的 warmup 機制（wake 時也會觸發）
- [[fleet-commands]] — /status 等命令的 Paused 狀態顯示
- [[crash-recovery]] — crash loop pause 機制

## Sources

- [[roadmap-2026-06-20]]
