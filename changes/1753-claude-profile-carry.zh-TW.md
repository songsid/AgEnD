---
section: Changed
---
- **切換 Claude Code agent 的 credential profile 時會保留原本的對話（#1753）。** 以前切換會開新對話，只給新 session 一段簡短的交接。現在 AgEnD 會在 agent 重啟期間，把這個 session 的對話紀錄、它的資料夾和檔案歷史複製到新 profile，agent 在那裡接續原本的對話。
  - 舊 profile 保留自己的那一份，所以切回去會回到同一段對話。
  - 切換後的第一次回覆會在快取為空的狀態下重讀整段對話，所以會比較慢，並以完整價格計費。
  - 這適用於 `update_instance_config` 和 ClassicBot 頻道。
  - 無法複製時，切換會像以前一樣開新對話並附上交接，回覆的 `carry_failed` 會說明原因。可能的原因有：還沒有 session、新 profile 已有這段對話的另一個版本、磁碟空間不足，或複製失敗。
  - Kiro 仍會開新對話；Codex 本來就不會失去對話。
