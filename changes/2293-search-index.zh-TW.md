---
section: Added
---
- **儀表板全域搜尋的索引（#2293）。** Fleet 會為以下內容建立自己的索引，讓你找回某件事當初是交給哪個 instance：聊天訊息（Discord、Telegram、網頁）、跨 instance 訊息（send_to_instance、delegate_task、report_result、broadcast），以及 Task Board 任務。`search.db` 由 worker thread 獨占，SQLite 工作不在 fleet 主迴圈上執行。第一次啟動時，會用 fleet 已有的資料補齊索引：聊天紀錄、delivery outbox 保留的 30 天訊息，以及所有任務。存入前會先遮蔽密鑰；訊息轉交的驗證 id、工作目錄與分支一律不建索引。`cross_instance_visibility` 設為 `hidden` 的 instance，其跨 instance 訊息不會出現在結果中。索引損毀時會移到一旁並重建。只有管理員工作階段可以搜尋：`GET /ui/search` 與 `/ui/search/context` 拒絕訪客與公開連結。`web.search.enabled: false` 可關閉搜尋；`web.search.retention_days`（預設 90）決定索引保留多久。搜尋框在下一個變更加入。
