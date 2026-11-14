---
section: Fixed
---
- 修正傳給忙碌中 Agent 的訊息，明明 Agent 已經收到，卻被標 ❌ 並提示「請再傳一次」的問題。Claude Code 與 Codex 有時會把幾則排隊中的訊息合成一則一起處理；AgEnD 現在能認出其中每一則，重新啟動後也不會再把這種訊息貼第二次。
