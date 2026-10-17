---
section: Added
---
- **Agent 可以讀取提示快取報告：`get_cache_report`（#2001）。** 它回傳儀表板 **Fleet → 快取** 顯示的同一份報告，每個 instance 包括：寫入時的 TTL 與 5 分鐘、1 小時快取寫入的比例、實際存活時間與空檔未命中率（#2010）、請求數、超過 TTL 的空檔、過期後重寫的請求與 token、過期成本、保溫模擬與建議、數字是估算還是牌價，以及涵蓋範圍。它依上一次掃描的結果回答，從不自己讀取 transcript；`scanning` 會說明掃描是否已追上。General、協調者與 full 權限的 instance 可以看到所有 instance 與 fleet 摘要，最多 `top` 列（預設 10）；其他 instance 只能看到自己那一列。儀表板的卡片現在也會顯示 5 分 / 1 時的寫入比例。
