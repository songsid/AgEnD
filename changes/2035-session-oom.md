---
section: Fixed
---
- **Break a session's OOM respawn loop (#2035).** Two confirmed Linux kernel OOM deaths of the same instance/session switch crash recovery to a fresh session with the available handover snapshot, retaining the old conversation and session ID. If that recovery also OOMs, it stops and tells the instance and General. Unknown deaths and macOS retain the existing restart policy.
