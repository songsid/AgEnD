---
section: Changed
---
- **kiro TUI 或 V3 啟動後，AgEnD 會輸入 `/session-id` 與 `/title`（#2681、#2684）。** `/session-id` 會與這次啟動依 id 恢復的對話比對。一致會記成已證明。不一致會顯示出來；AgEnD 不會從檔案猜測另一個對話。`/title` 設成 instance 名稱，接到 pane 時就看得出是哪一個。legacy UI 不變（tmux 視窗名稱）。
