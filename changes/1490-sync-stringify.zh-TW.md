---
section: Fixed
---
- **`saveCpuProfile`：大型 profile 在 `JSON.stringify` 之前就被拒絕。** 大小估算現在使用 `Buffer.byteLength(url, 'utf8')`（UTF-8 bytes）並加上 20% 的 JSON 跳脫開銷，讓含有 Unicode URL（例如 CJK 字元）的 profile 也能在事件迴圈分配大字串之前被捕捉到。含有 60,001 個 node 且 URL 佔 ~23 MiB 的 profile 在序列化前就被拒絕。(#1490 P3)
- **`CacheService.stop()` 現在回傳 `Promise<void>`，並在設定 `stopped = true` 前 join 正在執行的 pass。** 原本的 `void` 回傳型別讓呼叫端無法等待 flush 完成。新實作會先 join `this.running`（若有），再做最後一次 dirty 資料的存檔，最後才設定 `stopped = true`。`FleetManager.doStopAll()` 現在也會 await `cacheService.stop()`，確保 ledger flush 在關機前完成。(#1490 P3)
