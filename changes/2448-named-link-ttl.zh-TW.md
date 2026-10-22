---
section: Added
---
- **固定網域的公開連結可以開更久，並在重新啟動後自動重開。** 設定 `web.public_link.hostname`（Cloudflare named tunnel）時，`ttl_minutes` 最多可設 10080（7 天），或設 `0` 代表不到期：連結會一直開著，直到被關閉或 AgEnD 停止。新增的 `web.public_link.auto_open`（預設關閉，僅限固定網域）會在 AgEnD 啟動後，替上次用 `/web` 開啟連結的管理員重新開啟，並做同樣的就緒檢查；不會發任何訊息、也不會送出登入碼，所以手機主畫面捷徑在重新啟動後又能用，登入時仍需登入碼。按「關閉」或 `/web revoke` 後，直到下次 `/web` 前都不會自動開啟；重開失敗會再試兩次，之後以私訊通知該管理員一次。Quick tunnel 仍為 1–480 分鐘，沒有網域時，設定 → Web 會拒絕更長的時間、`0` 與 `auto_open`。
