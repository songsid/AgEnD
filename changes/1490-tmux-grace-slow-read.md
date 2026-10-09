---
section: Fixed
---
- **tmux observation after a reconnect, and one slow read (#1490):** after the tmux control connection reconnects, a window counts as idle only once it has been quiet for 2 seconds since its own pane was found again. Previously the 2-second grace started at the reconnect, so with many windows, or with tmux slow under load, the last windows read idle at once and a message could be pasted into a working CLI. A single control read slower than its 2-second budget is now answered by a one-shot read and drained, instead of tearing down the whole control connection and its view of every pane. The connection is reset only if that read's answer never arrives within 10 seconds.
