---
section: Added
---
- **Office: idle people now and then visit another area (#3685).** A skin pack can list `idleVisits`: areas, such as a garden or a hot spring, that an idle person sometimes walks to. They sit on a free seat there for a while and then walk back to their own seat. Each entry has a `weight` (1–100, weighed against 100 for the usual stroll near the seat) and a stay of `minSeconds`–`maxSeconds`. Visits follow the same switches as strolls. A pack without `idleVisits` walks as before.
