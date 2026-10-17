---
section: Fixed
---
- **Cron registration is logged, and a schedule that never got registered is repaired (#1995).** Each registration logs its schedule id, source and next run, so a missing registration can be told apart from a tick that never fired. A schedule enabled in the database but with no job in the running fleet is registered within a minute and its missed run caught up once. A schedule disabled and re-enabled through `agend schedule` no longer catches up a run from while it was disabled.
