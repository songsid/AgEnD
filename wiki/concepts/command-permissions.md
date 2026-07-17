---
type: concept
title: "指令權限架構"
tags: [architecture, security, command]
sources: [changelog-v2.0.5]
created: 2026-06-25
updated: 2026-06-25
---

# 指令權限架構

## 權限來源

| 類別 | 來源 | 指令 |
|------|------|------|
| Fleet admin | `fleet.yaml` → `channel.access.allowed_users` | /restart, /update, /doctor, /collab |
| Classic admin | `classicBot.yaml` → `defaults.admin_users` | /start, /stop, /save, /load |
| Context-dependent | 依平台/模式判斷 | /compact, /ctx, /collab |
| All users | 無檢查 | /status, /sysinfo, /ctx, @mention |

## /compact 權限差異

- TG Classic: 需要 admin_users
- TG Fleet + DC: 所有使用者

## TG vs DC 指令處理差異

- **TG**: text commands 需在 `handleGeneralCommand` 手動列出判斷
- **DC**: slash commands 有獨立 handler（`client.on('interactionCreate')`）

## 設計原則

- Fleet-level commands 統一走 fleet.yaml allowed_users
- Classic-level commands 統一走 classicBot.yaml admin_users
- Shared commands 需明確定義每個 context 的權限行為

## Sources

- [[changelog-v2.0.5]]
- [[fleet-commands]]
