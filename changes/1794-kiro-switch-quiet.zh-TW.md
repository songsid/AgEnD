---
section: Changed
---
- **kiro instance 不再把「恢復的對話沒有切換成這個 instance 的 agent」貼到頻道（#1794）。**
  - 恢復的 kiro 對話若 15 秒內沒能切換成 instance 自己的 agent，會照舊繼續執行，下次啟動再試；不會遺失任何東西，也不需要你處理，所以這則訊息現在只寫進 log 和該 instance 的「紀錄」分頁。
  - 「instance 已經切換成自己的 agent，但 AgEnD 無法記錄」同樣處理。
  - 「AgEnD 無法讀取或更新共用的 .kiro …」仍會貼出：那是你專案裡的檔案，需要手動修正。
