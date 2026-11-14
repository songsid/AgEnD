---
section: Fixed
---
- **Windows 面板上，傳給忙碌中 Agent 的訊息會在 Agent 真正讀取時才打 ✅（#3030 擴及原生與遠端面板）。** 以前，原生 Windows 或遠端面板上忙碌中的 Claude Code 或 Codex 一把訊息排進佇列就標成 ✅。現在和 Linux、macOS 一樣，AgEnD 會把它記著，直到 Agent 的對話紀錄顯示它已被讀取；Agent 閒下來卻沒讀取時會標成 ❌，並告訴你一次。AgEnD 重新啟動後，仍在同一個 Agent 佇列裡的訊息會繼續追蹤；原本的 Agent 已不在、又無法確認的訊息會標成 ❌，而不會重送，因為那個 Agent 可能仍持有它。
