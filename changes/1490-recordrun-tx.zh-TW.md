---
section: Fixed
---
- **排程器：`recordRun` 現在是原子操作。** `INSERT INTO schedule_runs` 和 `UPDATE schedules SET last_status` 已包在同一個 transaction 中。先前若兩個語句之間發生錯誤或崩潰，可能留下孤立的 run 記錄，而排程上的 `last_triggered_at` / `last_status` 未更新。(#1490 P3)
