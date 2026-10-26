---
section: Changed
---
- **CI：artifact 相關的 action 升到目前的主版本（#2671）。** `actions/upload-artifact` 4.6.2 → 7.0.2、`actions/download-artifact` 4.3.0 → 8.0.2（下載內容的摘要不符時，job 會直接失敗）、`actions/upload-pages-artifact` 3.0.1 → 5.0.0，仍以 SHA 釘選。它們改在 Node 24 上執行。workflow 步驟沒有改動：每個下載都是依名稱，上傳的目錄不依賴隱藏檔，網站建置結果也沒有點開頭的檔案。對使用者沒有影響。
