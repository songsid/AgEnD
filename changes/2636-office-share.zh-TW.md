---
section: Added
---
- **辦公室分享連結（#2636）：** 讓 fleet 以外的人在一段時間內觀看即時的辦公室。在 Fleet → 組織圖 → 辦公室 按 **分享…**（fleet 管理者，在直接連線的 dashboard），或在 General 用 `/office_share [辦公室|all] [30m|1h|…|24h] [text]`，就會建立一個不需登入就能打開的連結。
  - 觀看的人看到那間（或所有）辦公室，唯讀：名稱、識別色，以及誰在工作、閒置、睡著或在呼叫，每 5 秒更新。沒有聊天、設定或其他頁面；勾選後才顯示 agent 自己的狀態文字；hidden 的 agent 一律不顯示。
  - 預設 1 小時，15 分鐘到 24 小時（`web.office_share.max_hours`）；同時最多 10 個。連結走它自己的臨時通道，第一個連結建立時啟動、最後一個結束時關閉。可在 **設定 → 存取與安全 → 辦公室分享連結** 或用 `/office_share revoke` 撤銷；General 會公告誰建立或撤銷了連結。
  - Cloudflare 限制新的臨時通道時，建立連結會請你過幾分鐘再試。`web.office_share.enabled: false` 可關閉這個功能。
