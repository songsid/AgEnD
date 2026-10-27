---
section: Fixed
---
- **ClassicBot 聊天室的 collab 模式下，開啟原生回覆觸發時（`reply_triggers`，預設關閉：#2576），原生回覆某個 bot 的訊息，那個 bot 收得到（#2551）。** 自從 agent 的回覆變成真正的 Discord 回覆（#2456）後，另一個 fleet 的 bot 用 `reply_to` 回答一直送不到：聊天室只認文字中的 `<@bot>`。現在 bot 原生回覆本 bot 自己的訊息，就算是對它說話；回覆另一個 bot 的訊息時也會明確提及那個 bot。為了避免兩個 agent 無止境地互相回覆，若被回覆的訊息本身是在回覆某個 bot，就不會觸發；@ 提及仍會觸發。Fleet topic 與 Telegram 不受影響。
