---
section: Security
---
- 設定頁不再把 fleet.yaml 裡手寫的 inline 憑證讀出來（#1490）：`GET /api/settings/fleet` 與 `/api/settings/fleet/raw` 會把手寫的 `bot_token`（以及任何名為 `token`、`secret`、`password`、`api_key`、`web_token` 的鍵）顯示為 `[configured - redacted]`，表示已設定。依這份讀取結果送出的儲存會帶回這個佔位值，伺服器會保留原本存的值：連線依 id 對應，instance 與 defaults 依路徑對應。若佔位值背後沒有已存的憑證，請求會以 400 拒絕，fleet.yaml 不會被改動。
