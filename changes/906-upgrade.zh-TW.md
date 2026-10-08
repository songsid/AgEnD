---
section: Upgrade Notes
---
- **Kiro：升級後每個 instance 會切換一次（#906）。**
  - 這個版本以前的對話，恢復時會回到它存檔時的 kiro agent。
  - 第一次恢復時，AgEnD 會在投遞任何訊息之前，於該 instance 的 pane 輸入 `/agent swap <agent>` 並在畫面上確認，確認後才從共用的 `.kiro` 檔案移除該 instance 的舊項目。
  - 如果 15 秒內無法確認切換，就保留舊設定、發出通知，下次啟動再試。
  - 同一個目錄裡的兩個既有 kiro instance 都會指向該目錄最新的對話：先啟動的保留它，另一個開新的對話。
  - 這個版本以前的指示檔（`.kiro/steering/agend-<instance>.md`，沒有 fleet 標記）會保留，因為 AgEnD 無法判斷是哪個 fleet 寫的。等所有使用該目錄的 fleet 都升級後請手動刪除。
