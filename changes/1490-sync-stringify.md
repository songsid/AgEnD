---
section: Fixed
---
- **`saveCpuProfile`: large profiles rejected before `JSON.stringify`.** A V8 CPU profile with enough nodes to exceed the 20 MiB cap is now estimated structurally (node count × ~150 bytes/node) and rejected immediately, without synchronously serialising the full profile on the event loop. (#1490 P3)
- **`CacheService`: ledger saves throttled to at most once per 5 seconds.** Multiple rapid `kick()` calls within the throttle window are merged into one write. `stop()` bypasses the throttle to flush any pending dirty writes immediately. (#1490 P3)
