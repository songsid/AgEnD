---
section: Fixed
---
- **A dashboard chat left open for hours catches up like a reload (#2962).** After a long absence, such as a laptop asleep or a hidden tab, coming back no longer leaves the chat stuck on "Loading what is open now…" or "Could not load…" while a reload shows the newest messages. On a slow link (WSL's relay, a tunnel), the catch-up used to request every missed message across all agents in one answer that could not arrive in time. It now loads only the newest messages, and the open chat reloads its own recent history as a page reload would. A tab the browser froze no longer replays every missed heartbeat before showing the newest message. If a catch-up still fails, **Reload the page** appears next to Try again.
