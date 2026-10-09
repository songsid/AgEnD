---
section: Fixed
---
- **Backend detection no longer blocks the fleet (#1490):** `/ui/backends` ran `which` up to seven times per request, synchronously and with a 2 s timeout each, on the fleet's event loop. It now runs `which` as asynchronous child processes that must answer within 2 seconds (one that does not is killed and the backend shows as not installed, as before). An answer is reused for 30 seconds and concurrent requests share one lookup. A lookup that hangs, such as on a dead network mount, costs at most one process per backend until it really exits, never one per request. `/login` still probes fresh, so a CLI it just installed is seen at once.
