---
section: Fixed
---
- Grok instance 碰到週用量上限時，不會再停在 Grok 的「You hit your weekly limit.」提示（Upgrade tier / Buy more credits）上，也不會再出現「停在 CLI 對話框」警告和「需要你」項目。AgEnD 現在用 Shift+x 關掉提示，絕不選升級或購買額度，並以一則通知暫停該 instance；額度重置後，下一則訊息或 `/wake` 會讓它繼續。「停在 CLI 對話框」警告也不再附上 Claude 的 session-resume 建議，除非那正是 Claude 的 resume 提示。
