---
section: Changed
---
- **設定：狀態表情圖片改由 dashboard 自己提供（#1630）。** 狀態表情編輯器的伺服器表情清單與預覽，以前會在瀏覽器中從 Discord 的 CDN 載入，dashboard 的內容政策也因此允許 `cdn.discordapp.com/emojis/`。現在改用 dashboard 自己快取的路徑（與網頁聊天相同），內容政策不再允許任何遠端圖片：開著編輯器時，Discord 不會看到你的位址。不在 fleet bot 所在伺服器的表情會以 `:名稱:` 顯示。agent 的 `list_emojis` 圖片連結不變。
