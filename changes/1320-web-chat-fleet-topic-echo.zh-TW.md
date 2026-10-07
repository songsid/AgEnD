---
section: Added
---
- **Web chat → fleet 主題同步（#1320 part A）。** 成功的 web 訊息同步至綁定的 Telegram 或 Discord 主題，排序等待總共最多五秒，之後 Agent 回覆繼續。逾時丟棄尚未開始的副本；已在飛的副本可能晚到，結果另記日誌。`web.echo_to_channel` 預設開啟，可在 Settings 切換，未變更的選項不寫入設定。同步失敗不阻擋 web 投遞；mention／command 改成可見標籤，ingress 核對 fleet bot 作者與固定前綴，避免自己、同 fleet 的其他 bot 或重播副本觸發新回合；同平台任一已設定 bot 身分未知時暫時隔離 bot 前綴候選，人類不受影響。不包含 ClassicBot 或純 web fleet。
