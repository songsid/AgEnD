---
section: Added
---
- **The task board's daily summary (#2246).** Once a day, at `defaults.task_board.summary_at` (default `09:00` in the fleet's zone; `off` turns it off), each platform's General gets what waits for your confirmation and what is blocked, what got done and what is new since the last summary, and each project's progress. The web chat shows the same in General.
  - Each platform lists its own instances' cards.
  - A day when nothing waits and nothing moved sends nothing.
  - A summary missed while AgEnD was down goes out when it is back that day.
