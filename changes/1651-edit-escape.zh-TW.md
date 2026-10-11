---
section: Fixed
---
- **Agent：Telegram 上以 `format: "markdown"` 呼叫 `edit_message`，不會再因 `<` 或 `&` 而失敗（#1651）。** 自 #1654 起，這類編輯會把文字原樣當作 Telegram HTML 送出，因此像 `a<b` 或 `x & y` 這樣的文字會被拒絕（「can't parse entities」），而以前它們會以純文字送出成功。現在編輯文字會先全部跳脫再從 markdown 轉換：`<`、`&`、`>` 照原樣顯示，**粗體**、*斜體*、~~刪除線~~、`code` 與 http(s) 連結會套用格式。若 Telegram 仍拒絕該格式，會改以純文字重試一次。表格與程式碼區塊在編輯時不會重新呈現。
