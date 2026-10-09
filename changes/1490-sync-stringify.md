---
section: Fixed
---
- **`saveCpuProfile`: large profiles rejected before `JSON.stringify`.** Size estimation now accounts for all variable fields per node: callFrame URL and functionName (using `Buffer.byteLength(JSON.stringify(str), 'utf8') - 2` for exact UTF-8+escaping bytes), positionTicks arrays (V8 real field; 800k entries can exceed 16 MiB alone), and children arrays. The check exits the estimation loop early when the cap is reached, avoiding per-node work for oversized profiles. (#1490 P3)
- **`CacheService.stop()` returns `Promise<void>`, sets a closing flag, and flushes dirty data bounded to one save.** A `closing` flag fences new `kick()`/`start()` calls immediately. The in-flight pass loop exits at its next iteration boundary (not full backlog), then one bounded `save()` runs before `stopped = true`. `FleetManager.doStopAll()` now awaits `cacheService.stop()`. (#1490 P3)
