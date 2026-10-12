---
section: Changed
---
- **Web: Fleet → Schedules is readable, and schedules can be edited (#1724).**
  - **Rows:** each one shows its label (or the start of its message), then when it runs in words ("Weekdays 18:00", "Every 15 minutes", "Once · 2026-10-13 14:00 (UTC+8)"), its next run in the fleet's timezone, and the target's display name. The raw cron moves to the tooltip.
  - **One-time schedules:** they show their run time; before, that spot was blank.
  - **Disabled schedules:** they look disabled.
  - **Edit:** a new **Edit** button opens the schedule form filled in, with **Repeat / Once**. Saving goes through the same validation as the `update_schedule` tool.
  - **Create:** **New schedule** can now create one-time schedules, and creating from the web works again.
