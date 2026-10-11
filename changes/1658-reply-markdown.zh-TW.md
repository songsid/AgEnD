---
section: Changed
---
- **Agent：在 Telegram 上，`format: markdown` 現在就是 markdown；原始 HTML 標籤會以文字顯示（#1658）。** 以 `format: "markdown"` 呼叫 `reply` 時，文字會未經轉換就當作 HTML 送到 Telegram，因此含有 `<` 或 `&` 的文字（`a<b`、`x && y`）會被拒絕、回覆失敗，`**粗體**` 也會原樣顯示。現在會先全部跳脫再從 markdown 轉換：`<`、`&`、`>` 照原樣顯示，**粗體**、*斜體*、~~刪除線~~、`code` 與 http(s) 連結會套用格式。「markdown」模式下的 HTML 標籤從未列入文件，現在會以文字顯示。若 Telegram 仍拒絕該格式，會改以純文字再送一次。含有表格、程式碼區塊或標題的回覆，仍照舊以 Telegram rich message 送出。
