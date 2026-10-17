---
section: Fixed
---
- **A cron run that silently did not happen is now caught up, and every trigger is logged (#1995).** A daily schedule could skip a run with no trace: no run row, no `last_triggered_at`, nothing in the log, and only a restart caught up a missed run. Now a run that came due and did not start within 3 minutes runs once, under the same run id, so a late real trigger does not run it twice. The fleet log has one line per trigger, one with the reason for each trigger that does not start, and one for each run that fails.
