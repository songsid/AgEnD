---
section: Fixed
---
- 傳給「正在等自動重試啟動」的 instance 的訊息不再遺失。以前 30 秒後就標 ❌，即使重試在一分鐘後把 instance 帶起來。現在訊息會標為排隊中（Discord 上是 ⏳），等重試把 instance 帶起來後送達；只有重試放棄時才算失敗。傳給被人停止或暫停的 instance 的訊息，行為不變。
