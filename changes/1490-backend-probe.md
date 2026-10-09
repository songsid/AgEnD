---
section: Fixed
---
- **Backend detection no longer blocks the fleet (#1490):** `/ui/backends` ran `which` up to seven times per request, synchronously and with a 2 s timeout each, on the fleet's event loop. It now walks PATH with asynchronous file checks (no process started), reuses an answer for 30 seconds, and shares one walk between concurrent requests. `/login` still probes fresh, so a CLI it just installed is seen at once, and that answer refreshes what the Settings panel shows.
