---
section: Changed
---
- **`/settings` 現在是 app 的一部分（#1408，第 3 步）。**
  - 設定和聊天共用同一個側欄、外觀與主題；在兩者之間切換不再重新載入頁面。
  - Agent、連線、ClassicBot、一般和開發者是分頁，各有自己的網址（`/settings/<section>`）。每個 agent 和連線的設定會在對話框中開啟（手機上是底部面板），**新增 agent** 就是側欄的新增 instance。
  - 變更和以前一樣先暫存再一起套用。按下 **套用變更** 後，即使離開設定也會繼續，進度會在任何面板顯示。帶著暫存變更離開設定時會先詢問。
  - 需要 fleet 管理員確認的變更（#1423）會在任何面板顯示一張卡片，列出變更內容、剩餘時間和 **撤回**。需要確認的新增 instance、刪除或 Fleet 設定儲存也一樣。
  - 尚未得知的 agent 模型現在顯示「default (detected when it starts)」，取代「default (not probed yet)」。
