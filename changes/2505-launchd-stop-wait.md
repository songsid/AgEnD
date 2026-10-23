---
section: Fixed
---
- On macOS, `agend stop` now returns only once launchd has unloaded the fleet's job (#2505). It used to print "Service stopped." while the fleet was still shutting down, so an `agend start` right after failed with "Bootstrap failed: 5: Input/output error". If launchd still has the job after 30 s, `agend stop` says so and exits 1.
