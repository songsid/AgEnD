---
section: Added
---
- **Office levels: the data (#2661, part 1).** Each instance gets a level from its lifetime work: uncached input, cache writes and output. Cache reads don't count. The level is floor(√(work tokens ÷ 100,000)), with no cap.
  - The numbers come from the usage store the usage report already reads. The fleet works them out at most once a minute, and nothing new is collected.
  - Days older than the 400 days of usage history are carried into `usage-lifetime.json` before they're pruned, so a level never drops.
  - `GET /ui/office-levels` serves each instance's level. Work tokens, today and first seen are included only where the usage report is served.
  - A share link gets the level of the people it shows, and nothing else. `office_view` lists each member's `level`.
  - `web.office_levels: false` turns levels off.
