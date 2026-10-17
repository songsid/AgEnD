---
section: Added
---
- **Host memory pressure names the processes holding the most memory, and whose they are (#2015).** On Linux, while pressure is elevated or critical, the log, `/health` (`hostMemory.topProcesses`) and the Fleet dashboard header list the three largest processes in the fleet's service, each with its size and owner: an instance, the fleet itself or tmux. A runaway command an agent started can then be found and stopped before the kernel's OOM killer picks something. The list is rescanned at most once a minute, logged at most every 10 minutes, and cleared when pressure ends. Nothing is posted to chat (#1712).
