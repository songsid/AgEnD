---
section: Changed
---
- **網頁：General 可以顯示自己的 Bot，上傳的圖片也能移除（#1630 後續）。**
  - 主要 Bot 只有一個 instance 在用時（例如 fleet 只把主要 Bot 留給 General），會算是那個 instance 自己的 Bot，顯示 Bot 的頭像和 Discord 顏色外框。多個 instance 或聊天室共用的主要 Bot，照樣顯示但沒有外框。
  - View 的**編輯個人資料**在已上傳圖片時有**移除圖片**。儲存後刪除圖片，改回 Bot 的頭像、persona emoji 或名稱第一個字。
  - 路由是 `DELETE /api/avatar/<instance>`，和上傳一樣需要登入。
