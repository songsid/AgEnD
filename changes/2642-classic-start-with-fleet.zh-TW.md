---
section: Changed
---
- **ClassicBot 房間改為與 fleet 的 agent 一起啟動（#2642）。** 以前要等所有 fleet agent 啟動完、聊天連線接上、topic 與圖示都設好之後，它們才開始啟動。現在它們在 General 之後就進入同一個啟動佇列，記憶體吃緊時的節奏也相同。房間的訊息仍和以前一樣，從一開始就送到它那裡。完整重啟也是一樣。
