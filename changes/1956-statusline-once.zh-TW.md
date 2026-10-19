---
section: Fixed
---
- fleet 的狀態每次建立時，每個 agent 的 statusline.json 只讀一次（以前最多三次），也不再先另外檢查檔案是否存在（#1956）：在 40 個 agent 的測試 fleet 上，每次狀態建立的同步檔案呼叫從 247 次降到 167 次。
