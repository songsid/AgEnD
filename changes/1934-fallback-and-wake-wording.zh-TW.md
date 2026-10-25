---
section: Changed
---
- `file:` 提示參照只能相對於 Fleet 目錄找到時的警告，不再說這個退回機制會在 2.2 移除（它仍然存在），改為說明之後的版本會移除。功能說明現在區分明確喚醒（`wake_instance`，屬於管理工具）與 worker 的 `send_to_instance` 投遞給暫停中 instance 時可能造成的間接喚醒。
