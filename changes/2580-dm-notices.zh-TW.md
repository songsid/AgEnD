---
section: Changed
---
- **登入通知與每日提示維持發在頻道，不私訊（#2580）。** 撤回 2.3.2 beta 試行的私訊選項：Telegram bot 無法私訊還沒啟動過它的使用者。設定頁的 `web.notify_login` 與 `defaults.tips` 只有「頻道／關閉」，新 fleet 也不再把登入通知設為私訊。登入碼、訪客登入碼與公開連結仍以私下方式送出。
