---
section: Fixed
---
- **跨實例通知在 Discord、Telegram 和網頁聊天裡不再顯示內部訊息編號（#3056）。** 主題那一行、Mirror Topic、網頁聊天的狀態列會拿掉 `hmsg-` / `xmsg-` 編號、`verification_id` / `message_id` 標籤、`(verification_id …)` 括號，以及 `forwards: […]` 清單。收件的 agent 仍拿到原文和 `forwards` 欄位，一個字都不改。SHA、PR 編號和網址會留下。
