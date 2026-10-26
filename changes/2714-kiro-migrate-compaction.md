---
section: Fixed
---
- **kiro: moving a classic instance to the TUI now carries its conversation as it is after a `/compact` (#2714 follow-up; reported by hxhsandy).** Classic kiro continues a compacted conversation under a new id. An instance that had compacted but not restarted since would have carried its pre-compaction copy into the TUI.
  - `migrate_kiro_instance` now follows the same proven compaction chain a classic restart follows, and carries the newest conversation. The confirmation prompt says it does.
  - If the chain can't be proven, the move is refused and nothing is changed: the store can't be read, there are two continuations, or a continuation belongs to another instance. The move is one-way, so carrying the old id would leave the newer work behind.
