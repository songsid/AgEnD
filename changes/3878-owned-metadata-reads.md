---
section: Fixed
---
- Reduced Hub page CPU by avoiding owned graph copies in metadata-only freshness checks. Transport floors, fresh SQL and policy validation still run on each call, while callers that use or mutate full snapshots retain independent copies. Matched synthetic two-vCPU measurements reduce the three principal reads by about 18%; this is not an end-to-end latency guarantee.
