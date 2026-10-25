---
section: Fixed
---
- **2.3.2 beta 存下的私訊通知設定仍可載入（#2580）。** `web.notify_login` 或 `defaults.tips` 的 `"dm"` 值，以及任何 `web.notice_delivery` 鍵，都會接受並發出警告，視為開啟、發在頻道。啟動、重新載入與設定頁儲存時改寫成一般 boolean 並保留 `.bak`，任何舊版都能讀取。
