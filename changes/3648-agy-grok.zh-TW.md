---
section: Added
---
- **Antigravity 與 Grok instance 的聊天活動時間軸（#3648）。** Antigravity（`agy`）和 Grok instance 也有 Claude Code 與 Codex 已有的功能：紀錄分頁的步驟（開啟紀錄分頁時），以及登入的 admin 在聊天裡每則回覆上方看到的活動——依該 agent 自己的 `tool_progress`——中途說的話和工具呼叫。AgEnD 讀的是各 CLI 自己的紀錄——Antigravity 的對話 transcript 和 Grok 的 session `updates.jsonl`——並用紀錄裡的 id 把每個步驟對到它的回覆。思考的規則和它們相同：預設關閉（`web.log_thinking`），而且只有在這個 dashboard 登入的管理員看得到。
