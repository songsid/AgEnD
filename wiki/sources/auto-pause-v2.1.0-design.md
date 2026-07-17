---
type: source
title: "Auto-Pause v2.1.0 Design (detailed)"
tags: [architecture, feature]
version: "2.1.0"
raw: raw/auto-pause-v2.1.0-design.md
created: 2026-06-26
updated: 2026-06-26
ingested: 2026-06-26
---

# Auto-Pause v2.1.0 Design (detailed)

## Summary

完整設計包含狀態機、分來源 wake 策略、8 條 guardrail、架構重構需求、實作順序。

## 狀態機

Running → (idle 72hr) → Paused → (message arrives) → Running
Running → (user /stop) → Stopped
Running → (crash) → Crashed → (respawn) → Running

## Wake 策略（按來源）

| Source | Wake? | Mode | 理由 |
|--------|-------|------|------|
| User message | ✅ | sync | 用戶等回覆 |
| Fleet comms (send_to_instance) | ✅ | async | 訊息排隊，不阻塞 caller |
| Broadcast | ❌ | skip | paused instance 忽略 |
| Schedule | ❌ | skip | 有 schedule 者永不 pause |

## 8 條 Guardrail

1. **並發閘** — 同時只能有一個 wake 進行
2. **Broadcast 不 wake** — paused instance 忽略 broadcast
3. **Schedule 排除** — 有 active schedule 的 instance 永不被 pause
4. **Async wake** — fleet comms 不需要等 wake 完成
5. **correlation_id 去重** — 防止重複觸發 wake
6. **Wake ack** — wake 完成後通知 caller
7. **Waking 鎖** — 防止 wake 過程中重複觸發
8. **Stale-context 提示** — wake 後提示 instance context 可能過期

## 架構重構

需要抽出 `deliverToInstance()` facade：
- 統一 5 個 delivery 出口：user msg, fleet comm, broadcast, schedule, system
- Facade 內部判斷 wake policy（sync/async/skip）
- 取代目前散落在各處的 delivery 邏輯

## 實作順序

1. `deliverToInstance()` facade（抽統一入口）
2. 排除條件（schedule active、never_pause config）
3. wakePolicy 實作（sync/async/skip）
4. CLI marker file（pause 狀態持久化）

## Related

- [[auto-pause-design]] (earlier overview)
- [[roadmap]]
- [[crash-recovery]]
