---
section: Added
---
- **診斷 · 找出造成事件迴圈卡頓的資料庫（需手動開啟）。** 以 `AGEND_SQLITE_SYNC_TRACE=1` 啟動 fleet 後，每次較慢的同步 SQLite 寫入都會以檔名（`sqlite:<檔名>`）列在「Event loop stalled」紀錄中，卡頓若是在等磁碟，就能看出是哪個資料庫。預設關閉，關閉時沒有任何額外負擔。
