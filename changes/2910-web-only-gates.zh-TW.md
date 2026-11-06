---
section: Fixed
---
- 只用網頁的 fleet（沒有 Discord 或 Telegram 連線）可以完整運作：
  - 排程、任務板和 fleet 決策都能使用。
  - agent 之間可以互傳訊息（`send_to_instance`、`delegate_task`、`report_result`、`broadcast`）。
  - 在儀表板按 **新增 agent** 會建立沒有聊天 topic 的 agent。
  - `edit_message` 與 `download_attachment` 會說明純網頁的 fleet 無法使用，而不是叫 agent 重試。
  - 每一種啟動方式都用同一個規則決定 agent 的模式，因此有多個連線的 fleet 從儀表板或 CLI 重新啟動 agent 後，不會再失去 agent 之間互傳訊息的能力。
