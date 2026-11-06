---
section: Fixed
---
- **Fleet 關閉期間的 Telegram 訊息會保留。** 系統先停止收取訊息，再停止 Agent，期間仍可送出關閉通知。較晚抵達的更新不會推進本機紀錄或確認 Telegram 佇列，下次啟動時會正常接收。
