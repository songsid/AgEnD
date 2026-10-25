---
section: Fixed
---
- **主 Discord bot 登入期間有訊息要送出時，fleet 不再停在啟動途中、ClassicBot instance 也不再一直是 Stopped（#2642）。** 在 2.3.2-beta.3 到 beta.5，主 bot 登入時若有訊息經它送出，會重建它的 gateway 連線，把進行中的登入毀掉。結果這個 bot 一直上不了線（沒有出現「polling started」，「Discord gateway reconnect timed out」反覆出現），啟動停在「Fleet startup batch completed」之後：ClassicBot instance 沒有啟動，`agend fleet start` 一直回答 fleet 還在啟動中。現在送出時會等還在連線的 bot，而不是重建它；fleet 啟動等聊天連線最多 60 秒就繼續，晚一點連上的連線照常加入。
