---
section: Added
---
- **只用網頁的 fleet 可以在儀表板回答 agent 的對話框（#2910）。**AgEnD 留給人回答的 Claude Code 或 Codex 對話框，現在會出現在 agent 的聊天和 **等你處理**。畫面上會顯示對話框本身的文字和選項按鈕，你的選擇會在確認過游標位置後輸入到終端機。涵蓋的對話框：
  - Bash、Edit、Write 或 MCP 工具的權限（設定 `skipPermissions: false` 時）；
  - 認不得的信任或 Bypass Permissions 畫面；
  - 「Background work is running」；
  - 不是 AgEnD 要求的「Switch model?」；
  - Codex 等人處理的選單。

  不提供 Esc。終端機裡的密碼或 sudo 提示會變成通知，指引你到 agent 的 View 回答。有聊天連線的 fleet 不受影響。
