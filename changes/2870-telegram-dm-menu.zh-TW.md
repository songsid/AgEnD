---
section: Changed
---
- **Telegram：陌生人不再看到 ClassicBot 的指令選單，他們的指令也不會得到回應（#2870）。**
  - `/` 選單（`/start`、`/stop`、`/model`…）現在只出現在 ClassicBot 服務的聊天：它的聊天室，以及 `classicBot.yaml` 的 `allowed_users`、`admin_users`、`allowed_groups` 裡的 id。
  - 其他聊天都看不到選單。Telegram 的通用選單範圍會被寫成空的，舊的清單不會留著。
  - General 允許的聊天會立刻有選單。
  - 私訊裡，陌生人除了 `/start` 以外的指令完全不回應；`/start` 仍會向 General 請求存取權。
  - 已允許的使用者、ClassicBot 與 fleet 管理員、既有的聊天室和群組都和以前一樣。fleet 群組的選單和機器人的描述都沒有改變。
