---
section: Fixed
---
- **kiro：恢復的對話不再切換成 instance 自己的 agent，因為有 instance 切換後失去了 AgEnD 的工具（#1800）。**
  - 自 #906 起，AgEnD 會在恢復的 kiro 對話中輸入 `/agent swap`，把它切換成 instance 自己的 agent。有位使用者的 instance 切換後失去了 AgEnD 的工具：無法 `reply`，改用 subagent 繞過也沒有送出任何訊息。
  - 現已暫停這個切換。恢復的對話維持原本儲存時的 agent，並和 #906 之前一樣，從共用的 `.kiro` 檔案取得 AgEnD 的 server 與指示。
  - 已記錄過切換的 instance 會在下次啟動時拿回這些共用設定項目。重啟後請確認 instance 會呼叫 `reply`；預期這樣能讓工具恢復，但 kiro 本身的工具載入沒有經過實機驗證。
  - 新的對話仍以 instance 自己的 agent 啟動。
