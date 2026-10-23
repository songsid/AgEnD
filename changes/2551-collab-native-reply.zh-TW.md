---
section: Fixed
---
- **ClassicBot 房間的 collab 模式下，直接回覆某個 bot 的訊息，那個 bot 又收得到了（#2551）。** 自從 agent 的回覆變成真正的 Discord 回覆（#2456）後，另一個 fleet 的 bot 用 `reply_to` 回答時永遠送不到：房間只認文字中的 `<@bot>`。現在，bot 直接回覆本 bot 自己的訊息，也算是對它說話；回覆 bot 的訊息時也會明確提及它。為了避免兩個 agent 無止境地互相回覆，若被回覆的訊息本身是在回覆某個 bot 則不觸發，@ 提及仍會觸發。Fleet 主題與 Telegram 不受影響。
