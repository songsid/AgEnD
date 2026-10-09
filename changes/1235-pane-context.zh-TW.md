---
section: Fixed
---
- View 與狀態的 context 更新共用各 instance 的 tmux control 讀取路徑，連線正常時不再逐 instance 建立 capture 子程序。停機、respawn、pane 替換或取消後，尚未返回的舊結果不會套用。
- 快取目前使用者已驗證的 OS home，避免 tmux namespace getter 反覆查詢帳號資料庫。讀取失敗仍是 unknown，絕不以 `$HOME` 代替。
