---
section: Changed
---
- **An "Event loop stalled" warning now says, where it can prove it, whether the fleet was busy or waiting (#1235).**
  It reports the CPU time the event loop's thread got during the stall, and the host's load average. A thread that
  kept running through the stall means the fleet's own work blocked it. A thread that barely ran means the fleet was
  waiting: for a host busy with other work (such as big test runs on the same machine), or for a slow system call.
  When the numbers cannot tell the two apart, the warning says so. `docs/diagnostics.md` explains how to read it.
