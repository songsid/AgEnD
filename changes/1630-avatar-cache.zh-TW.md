---
section: Added
---
- **網頁：頭像與 Discord 伺服器表情改由 dashboard 自己提供（#1630 第一部分）。** 網頁收到的狀態現在會說明每個 instance 用什麼代表，依序為：在 View 上傳的圖片、它自己的 bot 頭像（只有擁有專屬 bot 時才用；共用 bot 的 instance 略過這一步）、persona emoji，或名稱的第一個字。在 Discord 伺服器裡有自己顏色的 bot，也會以該顏色作為強調色。bot 頭像與 fleet 所在 Discord 伺服器的自訂表情，會在主機上用 bot 自己的 token 取得，存在 `~/.agend/cache/`（每天最多更新一次；更新失敗時保留上一份），只提供給已登入的 session（臨時公開連結也可以讀取，僅限讀取）。頁面不會從 Discord 或 Telegram 載入圖片。側欄會在下一個變更開始顯示它們。
