---
section: Changed
---
- **刪除 agent 時，現在會一併刪除它的聊天 topic，並說明是否成功。** `delete_instance`（以及 dashboard 和「設定 → Agents」裡的刪除）預設會移除 agent 自己的 Telegram topic 或 Discord 頻道。傳入 `delete_topic: false` 可保留。
  - **透過正確的 bot 刪除。** 現在會透過 agent 自己的 bot 刪除。以前會用 fleet 的第一個 bot，在同時有 Telegram 和 Discord 的 fleet 上可能用錯平台。
  - **如實回報。** 只有 Telegram 或 Discord 確認刪除時，`topic_deleted` 才是 true；否則 `topic_reason` 會說明原因，例如「Telegram bot 沒有『管理主題』的管理員權限」或「找不到 topic」。無論如何，agent 本身都會刪除。
  - **永遠不刪除：** General topic、其他 agent 也在用的 topic，以及 ClassicBot 房間。在 Discord 上 topic 就是頻道，訊息記錄會一起刪除。(#3054)
