---
section: Fixed
---
- **更新到 beta.11 以上後，agent 會收到投票與網頁身分的通知（#1823、#1827）。**
  - what's-new 通知只在有新的 agent 項目時才送出，而 beta.7 之後就沒有新增項目。所以 `/update` 到 beta.10 或 beta.11 後，執行中的 agent 什麼也沒收到，可能繼續說舊的 AgEnD 版本，續用的 session 也不知道 `reply` 的 `poll` 和 `close_poll`。
  - 現在執行中的 instance 會收到一次通知：`reply` 接受 `poll`（附確切參數）、結果會以一則 `[poll results]` 訊息送來、`close_poll` 可提前結束投票。也會告知網頁聊天的使用者現在帶著他們的 Discord 或 Telegram 使用者 id，僅供辨識。
