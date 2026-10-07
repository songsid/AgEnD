---
section: Added
---
- **Web 聊天：可以傳檔案與圖片，也看得到 agent 回傳的檔案。** 輸入框有 📎 按鈕，也可以把檔案貼上或拖進聊天區（每則訊息最多 5 個、每個 10 MB、合計 25 MB；PNG、JPEG、GIF、WebP、PDF 與文字檔）。Agent 收到的方式和 Telegram 完全相同——檔案放在該 instance 工作區的 inbox、一行 `[📷 Image: …]` / `[📎 File: … → …]`，以及 `image_path` / `attachment_path`；agent 在回覆裡附的檔案也會顯示在 web 聊天中（圖片直接顯示，其他是下載連結）。檔案型別由內容判斷，不看檔名或瀏覽器的說法；存檔名由 fleet 決定；而且只能用 fleet 發出的 id 取回檔案（`/ui/file/<id>`），絕不能用路徑。四種圖片以外的檔案一律以下載方式提供，不會在頁面上渲染。附加了但 30 分鐘內沒送出的檔案會被刪除，fleet 中途重啟也一樣：上傳在被訊息帶走前存成 `web-pending-…`，重啟時會掃掉放超過 30 分鐘的（#1273）。已送出的檔案跟 Telegram 的一樣，依 inbox 的 7 天輪替處理。
