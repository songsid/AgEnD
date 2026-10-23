---
section: Fixed
---
- macOS `agend stop` 的後續修正（#2505）：等待後 launchd 仍保有工作時，訊息改用 fleet 的語言。`launchctl bootout` 卡到超過自己的逾時時，現在會繼續等工作卸載，不再改用 PID 停止 fleet。
