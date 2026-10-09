---
section: Fixed
---

- Fleet startup now reports whether the durable delivery outbox is locked, corrupt, blocked by a native SQLite driver mismatch, or unavailable for another reason, with recovery instructions. AgEnD does not quarantine or reset the queue; startup and new admission remain refused instead of discarding pending messages or submission evidence. Failed initialization/recovery closes its database owner and cannot publish a partially recovered store. (#1490)
