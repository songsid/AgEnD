---
section: Fixed
---
- **只是被鎖住或打不開的歷史檔不會再被丟掉（#1490）：**以前 `events.db` 開啟失敗時，不管原因為何，fleet 都會把它改名為 `events.db.corrupt-<時間>` 並另開一個空檔。現在只有 SQLite 證實不是可用資料庫的檔案（`SQLITE_NOTADB`、`SQLITE_CORRUPT`）才會被移開。若是鎖定超過 5 秒的 busy timeout、SQLite 驅動在這個 Node.js 上載入失敗（為其他版本或架構編譯），或是權限、磁碟問題，檔案都會原封不動：fleet 在重新啟動前不記錄事件，並把原因發到 General topic（驅動問題會附上 `npm rebuild better-sqlite3`）。
