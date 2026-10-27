---
section: Fixed
---
- **全新安裝時，第一個 Codex instance 不再誤報警告 (#2743)。** 在從未執行過 Codex 的機器上，第一個 Codex instance 會警告「Codex session database unreadable (SQLITE_CANTOPEN)」，並以 `codex resume --last` 啟動。其實 Codex 只是還沒建立 session 資料庫，沒有可接續的對話。現在資料庫不存在時，會直接開新對話，不再警告。資料庫存在但讀不到時，處理方式不變；資料庫不存在、但這個目錄已有 Codex 對話紀錄，或 AgEnD 無法讀取 Codex 資料夾來確認時，也維持原本的處理。
