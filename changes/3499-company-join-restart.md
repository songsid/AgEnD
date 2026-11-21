---
section: Fixed
---
- The company-join restart regression runs serially in CI and loads its real controller modules before the timed restart scenario, avoiding cold-transform contention without retries or longer deadlines.
