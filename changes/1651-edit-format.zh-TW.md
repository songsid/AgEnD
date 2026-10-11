---
section: Fixed
---
- **Agent：`edit_message` 會保留訊息格式（#1651）。** `edit_message` 有 `format` 參數卻會忽略它，因此在 Telegram 上，編輯一則以 `format: "markdown"` 送出的訊息，結果會變成純文字。現在編輯的呈現方式與 `reply` 相同：Telegram 會套用 `format: "markdown"`；Discord 本來就一律呈現 Markdown，維持不變。
