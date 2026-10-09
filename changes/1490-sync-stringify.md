---
section: Fixed
---
- **`saveCpuProfile`: large profiles rejected before `JSON.stringify`.** The size estimate now accounts for variable-length fields: `callFrame.url`, `callFrame.functionName`, `timeDeltas`, and per-node fixed overhead. A profile with 70,001 nodes and 336-character URLs is correctly rejected without serialising the full string. (#1490 P3)
- **`CacheService.stop()`: returns a `Promise` and flushes dirty data before setting `stopped = true`.** The previous `void` return type meant dirty data could be silently discarded on shutdown. The flush (if any dirty data is pending) now completes before the service is marked stopped. (#1490 P3)
