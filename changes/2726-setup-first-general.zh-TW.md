---
section: Fixed
---
- **在 Telegram 或 Discord 連線上設定的第一個 agent，現在就是 fleet 的 General。** 設定頁（`agend setup`，Windows 安裝程式開啟的那一頁）與 設定 → 設定精靈 預設把它命名為 `general`。它在聊天本身的 General 主題回覆：Telegram 群組內建的 General，或 Discord 連線的 general 頻道。以前它被寫成一般的 agent：fleet 啟動時會再加一個 agent 當 General；而你命名為 `general` 的 agent 會多開一個新的論壇主題，fleet 也完全沒有 General。名稱可以自訂，自己輸入的名稱會保留；只用網頁的設定仍以 `agent-1` 開始。fleet 已經有連線或 General 時，新的 agent 不能命名為 `general`。既有的 fleet 若有名為 `general` 的 agent、卻沒有 General，下次啟動時會修正：那個 agent 成為 General，並使用聊天的 General 主題（M-2069）。
