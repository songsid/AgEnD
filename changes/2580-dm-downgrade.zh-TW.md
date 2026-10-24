---
section: Fixed
---
- **私訊通知設定可相容於 stable 降版及 Mac 自動還原版本（#2580）。** 設定頁改將私訊路由存入 `web.notice_delivery`，`web.notify_login` 和 `defaults.tips` 保持 boolean。舊版改送原頻道，保留偏好供之後升版恢復。新 fleet 仍預設登入通知私訊；短暫使用的字串格式會保留備份後轉換。降版 CI 新增以已發布舊版 validator 和設定重寫驗證產生的 YAML。
