---
section: Upgrade Notes
---
- **從 2.3.2 beta 升級：登入通知與每日提示改回發在 topic，不私訊（#2580）。** 撤回 beta 試行的私訊選項：Telegram bot 無法私訊還沒啟動過它的人。設定頁的 `web.notify_login` 與 `defaults.tips` 只有「Topic／關閉」，新 fleet 也不再把登入通知設為私訊。登入碼、訪客登入碼與公開連結的傳送仍是私下的。
