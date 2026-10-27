---
section: Added
---
- **辦公室等級：資料部分（#2661，第 1 部分）。** 每個 instance 依它的終身工作量得到一個等級：未快取的輸入、快取寫入與輸出。快取讀取不算。等級＝floor(√(工作 token ÷ 100,000))，沒有上限。
  - 數字來自用量報告原本就讀的用量資料。fleet 每分鐘最多計算一次，不會多收集任何東西。
  - 超過 400 天用量紀錄的日子，在清除前會先累計到 `usage-lifetime.json`，所以等級不會下降。
  - `GET /ui/office-levels` 提供每個 instance 的等級。工作 token、今天的數字與首次出現，只在用量報告有提供的地方才附上。
  - 分享連結只拿得到它顯示的人的等級，其他都沒有。`office_view` 會列出每位成員的 `level`。
  - `web.office_levels: false` 關閉等級。
