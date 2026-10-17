---
section: Added
---
- **網頁：艦隊的跨實例往來訊息，為即將推出的組織畫布做準備（#1918）。** 儀表板的串流現在會在實例之間的訊息排入佇列、開始投遞、投遞完成、被接收者讀取或失敗時，送出 `traffic` 事件。涵蓋 `send_to_instance`、`delegate_task`、`report_result`、`request_information` 與 `broadcast`。新的讀取路徑 `GET /ui/traffic` 提供目前正在傳送中的訊息，加上最近兩分鐘內完成的訊息，最多 200 筆。公開連結沒有串流，因此也可以讀取它。每一筆只包含兩個實例的名稱、種類、狀態、時間與一個不透明的 id：絕不包含訊息本身、訊息的 id 或內文。艦隊通知不算往來訊息；`cross_instance_visibility` 為 `hidden` 的實例永遠不會出現。艦隊不會為此新增任何探測，只轉送投遞外寄佇列（delivery outbox）本來就記錄的內容；不論被問得多頻繁，這個讀取最多每兩秒計算一次。
