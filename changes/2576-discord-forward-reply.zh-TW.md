---
section: Fixed
---
- **把我們 bot 的圖片轉發到另一個 ClassicBot 聊天室，不再誤觸發 bot（#2576）。** Discord 轉發只作為脈絡，不算原生回覆或發送者的提及；轉發圖片仍保留。原生回覆觸發改為預設關閉、可選開啟：`fleet.yaml` 的 `defaults.reply_triggers` 可由 `classicBot.yaml` 預設或個別 channel 的 `reply_triggers` 覆寫。設定頁顯示預設與繼承的有效值。精確提及仍會觸發，fleet-topic 的 bot 流量規則不變。
