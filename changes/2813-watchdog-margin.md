---
section: Fixed
---
- Reduced avoidable full-fleet restarts under heavy host load: watchdog notifications now run every 10 seconds, with one prompt retry after a failed ping. Each failed attempt records its exit code, signal, timeout/kill flag and elapsed time. A genuinely blocked main loop still stops feeding the watchdog.
