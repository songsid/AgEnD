---
section: Changed
---
- **登入通知與每日提示恢復發在頻道，不再私訊（#2580）。** 撤回 2.3.2 beta 的私訊選項：Telegram bot 無法私訊還沒啟動過它的使用者。設定頁的 `web.notify_login` 與 `defaults.tips` 只有「頻道／關閉」，新 fleet 也不再把登入通知設為私訊。既有的 `"dm"` 值或 `web.notice_delivery` 路由仍可載入、視為開啟，啟動時改寫成 boolean 並保留 `.bak`。登入碼、訪客登入碼與公開連結仍以私下方式送出。
