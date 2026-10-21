---
section: Fixed
---
- **Fleet startup no longer pays stagger twice for nested spawns (#2288).** Healthy nested startup keeps its existing admission slot without delaying the next instance. Memory-pressure spacing and storm limits remain active. Startup batches now log elapsed time, ready count and measured peak concurrency.
