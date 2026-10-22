---
section: Fixed
---
- **Keep memory-deferred fleet startup out of a service restart loop (#2461).** Renew systemd’s startup deadline while queued startup spawns wait for memory, without declaring the fleet ready early. Start event-loop watchdog monitoring before General and bound bulk stop batches under pressure; normal startup and pressure admission limits are unchanged.
