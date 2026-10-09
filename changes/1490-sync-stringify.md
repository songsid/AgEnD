---
section: Fixed
---
- **`saveCpuProfile`: large profiles rejected before `JSON.stringify`.** Size estimation now uses `Buffer.byteLength(url, 'utf8')` (UTF-8 bytes) with 20% headroom for JSON-escaping, so profiles with Unicode URLs (e.g. CJK characters) are also caught before the event loop allocates a large string. A profile with 60,001 nodes × 336-byte CJK URLs (~23 MiB) is rejected without serialising. (#1490 P3)
- **`CacheService.stop()` now returns `Promise<void>` and joins any in-flight pass before flushing.** The previous `void` return meant callers could not await the flush. The new implementation joins `this.running` (if any), then does a final save of dirty data before setting `stopped = true`. `FleetManager.doStopAll()` now awaits `cacheService.stop()` so the ledger flush completes before shutdown. (#1490 P3)
