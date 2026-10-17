---
section: Added
---
- **叫你到另一個主題的訊息，現在會直接附上連結（#1990）。** 連結在 Discord 和 Telegram 上都會開到該處。Telegram 的連結就在文字本身（可點的「General」或 instance 名稱）；Discord 則是頻道提及（`#general`）。
  - **叫你到 General 的回覆**：結尾會加上連到 General 的「→ General」。適用於在 instance 主題裡輸入只能在 General 用的指令、在 General 以外用 `/profile`、在 General 以外用 `/web`，以及在沒有綁定 instance 的主題裡發訊息。
  - **instance 自己指向 General 的通知**也帶同樣的連結：「正常停止」與「在等待互動輸入」。
  - **General 裡提到 instance 的通知**：instance 名稱會連到它的主題。包括重新啟動與協助按鈕的提示、「停在對話框上」、「沒有接受回答」，以及「無法辨識的提示」。
  - **主題裡的跨 instance 狀態列**會連到另一方：目標主題的那行連到發送者的主題，發送者主題的那行連到目標的主題。
  - **讀者可能打不開時不附連結**：ClassicBot 房間裡、其他 bot 的 instance，以及網頁 dashboard（網頁的連結在下一個 PR）。agent 或 pane 的文字永遠無法自己產生連結。
