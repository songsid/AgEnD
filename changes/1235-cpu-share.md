---
section: Changed
---
- **An "Event loop stalled" warning now says whether the fleet was busy or waiting (#1235).** It reports how much
  CPU the fleet process got during the stall, and the host's load average. CPU close to the stall's length means the
  fleet's own work blocked it. CPU far below it means the fleet was waiting: for a host busy with other work (such as
  big test runs on the same machine), or for a slow system call. `docs/diagnostics.md` explains how to read the warning.
