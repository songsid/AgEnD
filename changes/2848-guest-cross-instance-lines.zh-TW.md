---
section: Changed
---
- **訪客看得到 agent 頻道裡顯示的 agent 間訊息（#2848）。** 一個 agent 傳給另一個 agent 的訊息，原本就會依 `cross_instance_visibility` 貼到雙方的 Discord 或 Telegram 頻道（全文、一行摘要或不貼）。現在網頁訪客也會在該 agent 的聊天裡看到這些同樣的內容，頻道沒顯示的則看不到。這個版本之前留下的訊息仍不會給訪客看。如果訪客對某個 agent 的訊息一則都看不到，聊天畫面會說明原因，而不是一片空白。
