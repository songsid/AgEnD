---
type: synthesis
title: "Fleet Skills / 自訂快捷指令（構想）"
tags: [feature, architecture]
sources: []
source_version: v2.0.11
created: 2026-07-16
updated: 2026-07-16
---

# Fleet Skills / 自訂快捷指令（構想中）

## 需求

用戶希望在 TG/DC 按按鈕就能觸發預設指令，不用打字。例如 git 操作快捷鍵。

## 設計方向

- `/skills` 或 `/panel` slash command → 列出可用的快捷指令
- TG: inline keyboard
- DC: select menu
- 用戶點選 → AgEnD 把預設 message 送給目標 instance
- 儲存在 SQLite（跟 schedule 同機制，只是觸發方式不同）
- 可 per-instance 或全域
- 不佔 slash command 名額（只需 1 個 `/skills`）

## 與 Schedule 的關係

| | Schedule | Fleet Skill |
|---|---|---|
| 觸發方式 | 時間（cron） | 用戶手動（button） |
| 儲存 | SQLite | SQLite（共用） |
| 路由 | 同 | 同 |

## 可能的整合 UI

- `/panel` 同時列 skills + schedules
- 或分開 `/skills` + `/schedule`

## 狀態

構想階段，未排入版本。可能 v2.1+。

## Related

- [[fleet-commands]]
- [[roadmap]]
