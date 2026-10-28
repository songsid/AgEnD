---
section: Changed
---
- **General is quiet on a normal day (#2804).** The 21:00 daily cost report is now off unless you set `defaults.daily_summary.enabled: true`; set it and it comes back exactly as before. Log and inbox rotation still run every day either way. The task board's 09:00 daily summary is gone; a `defaults.task_board.summary_at` already in `fleet.yaml` still loads and is ignored. Costs stay on the dashboard's Usage page.
