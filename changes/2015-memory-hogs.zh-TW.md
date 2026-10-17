---
section: Added
---
- **主機記憶體壓力會列出用最多記憶體的行程及其所屬（#2015）。** 在 Linux 上，壓力為 elevated 或 critical 期間，log、`/health`（`hostMemory.topProcesses`）與儀表板 Fleet 頁面的標頭會列出 fleet 服務裡最大的三個行程，含大小與所屬：某個 instance、fleet 本身或 tmux。這樣就能在 kernel 的 OOM killer 挑行程 kill 之前，找出並停掉 agent 跑出的失控指令。清單最多每分鐘重新掃描一次、最多每 10 分鐘寫一次 log，壓力結束時清除。不會發到聊天（#1712）。
