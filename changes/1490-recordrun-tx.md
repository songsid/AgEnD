---
section: Fixed
---
- **Scheduler: `recordRun` is now atomic.** The `INSERT INTO schedule_runs` and `UPDATE schedules SET last_status` are wrapped in a single transaction. Previously a crash or error between the two statements could leave an orphaned run record without an updated `last_triggered_at` / `last_status` on the schedule. (#1490 P3)
