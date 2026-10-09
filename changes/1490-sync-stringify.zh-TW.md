---
section: Fixed
---
- **`saveCpuProfile`：大型 profile 在 `JSON.stringify` 之前就被拒絕。** 超過 20 MiB 上限的 V8 CPU profile 現在以結構估算（node 數 × ~150 bytes/node）直接拒絕，不再同步在事件迴圈上序列化完整的 profile。(#1490 P3)
- **`CacheService`：ledger 存檔節流至每 5 秒最多一次。** 節流視窗內的多次 `kick()` 呼叫合併成一次寫入。`stop()` 略過節流，立即 flush 所有待寫的 dirty 資料。(#1490 P3)
