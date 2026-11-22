---
section: Fixed
---
- Merge-gate tests release scratch Git repositories after each case, avoiding a cumulative final cleanup that could exceed CI's hook budget. Gate behavior, timeouts and retries are unchanged.
