---
section: Fixed
---
- 儲存公開連結變更時，不再把每個已暫停或其他團隊的 Agent 列成「重新啟動此 Agent」。套用摘要對沒有 live daemon 的 instance 也走 `classifyInstanceChange`，只有 instance 區塊真的變了才會列出。
