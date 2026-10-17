---
section: Changed
---
- **Cache report: what a 5-minute cache really lasts (#2010).** Since 2026-10-15, Claude's caches labelled 5 minutes often survive an hour, so the keep-warm simulation overstated how many pings were needed. The report now measures each instance's gaps of 5 to 60 minutes over the last 7 days.
  - If at most 10% of at least 10 such gaps rewrote the cache, it counts as 1 hour and is simulated that way.
  - If at least half did, the card recommends `backend_options.claude-code.prompt_cache_ttl: "1h"` instead of keep-warm, and the fleet row counts such instances.
  - With fewer gaps, it says there is not enough evidence and marks the figures as estimates.
  - The gap-miss rate is shown on each card and in `get_cache_report`.
