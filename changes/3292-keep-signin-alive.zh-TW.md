---
section: Added
---
- **設定 → 帳號：保持登入。** 沒有 agent 在用的 Claude Code 或 Codex 登入以前會在不知不覺中過期，因為 CLI 只有在執行時才會續期登入。現在每個 Claude Code 與 Codex 帳號（預設登入和每個具名帳號）都有 **保持登入** 勾選框，預設關閉。勾選後，AgEnD 大約每天檢查一次，到期時用 CLI 自己的工具續期，不會呼叫模型：Claude Code 用 `claude auth status`，Codex 透過 app-server 的帳號讀取並要求刷新；結果從帳號自己的檔案讀回。正在被執行中的 agent 或 ClassicBot 房間使用的登入不會動。Claude Code 另有一個勾選框，允許在狀態檢查沒有續期時，用最小的模型送一次很小的請求。那一列會顯示登入何時到期（Claude Code 登入的到期日不會因續期而延後）、Codex 的方案與上次結果。續期失敗或沒有生效時，**需要你** 會請你重新登入；連不上服務時連續失敗兩天才提醒；Claude Code 登入在到期前十天起提醒。記錄只寫名稱、結果與日期，絕不寫權杖。
