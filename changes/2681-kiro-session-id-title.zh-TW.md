---
section: Changed
---
- **kiro TUI 或 V3 啟動後，AgEnD 會輸入 `/session-id` 與 `/title`（#2681、#2684、#2683）。** 每個指令只會輸入到空的輸入框，不會打進草稿。輸入框確實只顯示這個指令時才按 Enter；指令若留在輸入框裡，就不再輸入其他東西。`/session-id` 會與這次啟動依 id 恢復的對話比對。只有 kiro 對這次指令的回應才算數：畫面上原本就有的 `Session ID:`，或對話中引用的，都不算。一致會記成已證明。不一致會顯示出來；AgEnD 不會從檔案猜測另一個對話。`/title` 設成 instance 名稱；kiro 開啟終端機標題（`/settings display`）時才會套用。legacy UI 不變（tmux 視窗名稱）。
