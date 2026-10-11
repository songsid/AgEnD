---
section: Added
---
- **Agent：升級後，每個 agent 會收到一次「對你而言有什麼新功能」的通知（#1633）。** 在舊版 AgEnD 時開始的 session 可能不知道新的工具參數：Claude Code 會沿用對話中先前載入的工具說明，因此看不到 `reply` 的 `buttons` 或 `stickers`。現在每個既有 instance 會在收到下一則訊息前收到一則簡短通知（不會在 turn 進行中插入，也不會發給沒人傳訊息的 instance），列出與 agent 相關的變更與確切參數名稱，並提醒重新載入看起來較舊的工具說明。每一項每個 instance 只會收到一次，紀錄在重啟後仍保留。新 instance 不會收到，因為它們一開始就是最新的工具。沒有 agent 相關變更的版本不會發送任何通知。
