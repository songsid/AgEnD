---
section: Security
---
- **Dashboard 不再依賴 Server-Sent Events。** 即時串流 15 秒沒有任何訊息或一直失敗時，頁面改為每 5 秒用 `GET /ui/poll` 取得相同的狀態與聊天訊息，串流恢復後再切回去。輪詢與串流使用同一個 `<boot>-<id>` 游標，所以兩者交替時不會重複也不會漏訊息，fleet 重啟後也一樣。（Cloudflare Quick Tunnel 不支援 SSE，會緩衝串流的 proxy 看起來就像從不送資料的伺服器。）
