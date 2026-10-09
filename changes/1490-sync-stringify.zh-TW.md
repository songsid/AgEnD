---
section: Fixed
---
- **`saveCpuProfile`：大型 profile 在 `JSON.stringify` 之前就被拒絕。** 大小估算現在涵蓋每個 node 的所有可變欄位：callFrame URL 與 functionName（使用 `Buffer.byteLength(JSON.stringify(str), 'utf8') - 2` 取得精確的 UTF-8 加跳脫位元組數）、positionTicks 陣列（V8 真實欄位；80 萬筆項目單獨就可能超過 16 MiB）和 children 陣列。估算迴圈在達到上限時提前中止，避免超大 profile 繼續逐 node 計算。(#1490 P3)
- **`CacheService.stop()` 回傳 `Promise<void>`，設定 closing 旗標，並以一次有界 save 完成 flush。** `closing` 旗標立即阻擋新的 `kick()`/`start()` 呼叫。進行中的 pass 迴圈在下一次迭代邊界離開（而非掃完整個 backlog），然後執行一次有界的 `save()` 再設定 `stopped = true`。`FleetManager.doStopAll()` 現在也會 await `cacheService.stop()`。(#1490 P3)
