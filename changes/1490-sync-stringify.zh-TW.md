---
section: Fixed
---
- **`saveCpuProfile`：大型 profile 在 `JSON.stringify` 之前就被拒絕。** 大小估算現在涵蓋可變長度欄位：`callFrame.url`、`callFrame.functionName`、`timeDeltas` 及每個 node 的固定開銷。含有 70,001 個 node 且 URL 長達 336 字元的 profile 能在序列化前被正確拒絕。(#1490 P3)
- **`CacheService.stop()`：現在回傳 `Promise`，並在設定 `stopped = true` 之前 flush 待寫資料。** 原本的 `void` 回傳型別導致停機時可能靜默丟棄 dirty 資料。現在 flush（如有待寫資料）會在服務標記為已停止之前完成。(#1490 P3)
