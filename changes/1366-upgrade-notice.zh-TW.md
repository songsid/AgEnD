---
section: Upgrade Notes
---
- **第一次以 2.2 啟動時，會在 General 介紹網頁聊天一次（#1366）。** 每個聊天平台的 General 會收到一則簡短訊息：網頁聊天
  是什麼、它和 topic 是同一段對話，以及用 `/dashboard` 登入。這會記在 `~/.agend/upgrade-notices.json`，之後不再重複；
  還沒有地方張貼 fleet 通知的平台，等有了之後才會收到。傳送失敗的訊息會在下次啟動時再試。
