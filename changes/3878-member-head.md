---
section: Fixed
---
- Reduced Hub room and sharing page CPU by skipping a transport graph copy that member-address freshness checks discarded. Every SQL, revision-floor and currentness check still runs. Matched synthetic two-vCPU reads use about 9–11% less median CPU; production latency depends on the workload.
