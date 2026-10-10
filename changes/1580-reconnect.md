---
section: Changed
---
- **Web: an open dashboard tab rides out a fleet restart quietly (#1580).** When AgEnD restarts, each open tab used to retry about every 3 seconds and poll every 5 seconds at the same time, forever, even when hidden — dozens of connections a minute per tab, through WSL2's port relay or a tunnel. Now a tab waits longer between tries (about 1, 2, 4, 8, 16, then 30 seconds), pauses while it is hidden, keeps one connection at most, and closes it when the tab is closed. The page says "Can't reach AgEnD — it may be restarting" with when it tries again. When AgEnD is back, what was said meanwhile appears, once — before, a tab could miss those messages.
