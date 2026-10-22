---
section: Fixed
---
- **A stop no longer leaves the tmux helper for systemd to kill (#2364).** When the fleet stopped, it closed its small tmux helper process and exited at once, so under the systemd unit the helper was killed with what was left of the service, and a system unit logged "remains running after unit stopped" for it. The stop now waits up to 2 seconds for the helper to finish and exit on its own.
