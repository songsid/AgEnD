---
section: Changed
---
- **Runtime 頁的帳號清單（credential profile 與各登入是哪一個帳號）改由延遲載入的 Runtime 頁自己帶樣式**，不再放在共用樣式檔，所以升級前就開著的分頁不必重新載入才會有樣式。文件現在註明遮罩的 email 與方案只有直接連到 dashboard 的 fleet 管理員看得到（經由公開連結或固定位址看不到），並新增測試，用真實 `claude auth status` 的欄位名稱對照 AgEnD 讀取的欄位。
