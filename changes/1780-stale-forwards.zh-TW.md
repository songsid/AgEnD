---
section: Fixed
---
- **跨升級續用的 agent 又能傳 `forwards` 了（#1780）。**
  - 跨 beta.7 升級續用的 Claude Code session 仍看到舊版 `send_to_instance`，沒有 `forwards`。它改把 verification ID 寫進訊息內文，但這不會授權，所以收件者的 `delivery_status` 回「Delivery not found」。
  - Claude Code 會沿用 session 第一次載入時的工具 schema，重新載入也不會更新。AgEnD 伺服器仍接受新參數。
  - 現在執行中的 instance 會收到一次 what's-new 通知：`send_to_instance` 和 `delegate_task` 接受 `forwards`，而內文提到的 ID 不會授權。通知不再建議重新載入工具，而是請 agent 照樣使用新參數。
  - 轉交指引（skill、工具說明與文件）寫明了這種失敗情況。
