---
section: Changed
---
- **ClassicBot 聊天室預設同步 web chat（#2054）。** 從 web chat 傳給 ClassicBot instance 的訊息，現在會像 fleet 頻道一樣同步到它的聊天室（`🌐 web · <名字>: …`），群組頻道也一樣。沒有設定 `web_echo` 的聊天室依照全 fleet 的 `web.echo_to_channel`，所以已經關掉 web 同步的 fleet 會維持關閉。在 `classicBot.yaml` 設定 `web_echo: false`（或在該聊天室的 Settings 取消勾選「Web 同步」）可讓單一聊天室保持關閉，這個選擇會明確存檔。**升級後，原本沒有設定 `web_echo` 的聊天室會開始同步**；不想同步的聊天室請設定 `web_echo: false`。對群組頻道開啟同步時的確認視窗已移除。
